import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { scim_group_members, scim_groups, scim_users } from "../../../db/schema.ts";
import { matches_filter } from "./filter.ts";
import { paginate, type ListQuery } from "./pagination.ts";
import {
  GroupMember,
  type GroupInput,
  type GroupListResponse,
  type GroupResource,
  type PatchOperation,
} from "../schemas.ts";
import { ScimServiceError } from "./error.ts";
import { group_resource } from "./resources.ts";

type DynamicObject = Record<string, unknown>;

async function find_group(server_id: string, group_id: string) {
  const rows = await db
    .select()
    .from(scim_groups)
    .where(and(eq(scim_groups.server_id, server_id), eq(scim_groups.id, group_id)))
    .limit(1);
  if (!rows[0]) {
    throw new ScimServiceError("group_not_found", "Group not found.");
  }
  return rows[0];
}

async function replace_group_members(server_id: string, group_id: string, members: GroupMember[]): Promise<void> {
  const user_ids = [...new Set(members.map((member) => member.value).filter(Boolean))];

  // Validate the complete replacement before deleting current memberships.
  // This also prevents a group from referencing users on another SCIM server.
  if (user_ids.length) {
    const valid_users = await db
      .select({ id: scim_users.id })
      .from(scim_users)
      .where(and(eq(scim_users.server_id, server_id), inArray(scim_users.id, user_ids)));
    if (valid_users.length !== user_ids.length) {
      throw new ScimServiceError("group_members_invalid", "One or more group members do not exist on this server.");
    }
  }
  await db.transaction(async (transaction) => {
    await transaction.delete(scim_group_members).where(eq(scim_group_members.group_id, group_id));
    if (user_ids.length) {
      await transaction.insert(scim_group_members).values(user_ids.map((user_id) => ({ group_id, user_id })));
    }
  });
}

function parse_group_members(value: unknown): GroupMember[] {
  const result = GroupMember.array().safeParse(value);
  if (!result.success) {
    throw new ScimServiceError("group_members_invalid", "Group members must be an array of member objects.");
  }
  return result.data;
}

export async function list_groups(server_id: string, origin: string, query: ListQuery): Promise<GroupListResponse> {
  const rows = await db
    .select()
    .from(scim_groups)
    .where(eq(scim_groups.server_id, server_id))
    .orderBy(asc(scim_groups.created_at));
  let resources = await Promise.all(rows.map((row) => group_resource(row, origin)));
  if (query.filter) {
    const filter = query.filter;
    try {
      resources = resources.filter((resource) => matches_filter(resource, filter));
    } catch {
      throw new ScimServiceError("filter_invalid", "The supplied filter is invalid or unsupported.");
    }
  }
  return paginate(resources, query);
}

export async function get_group(server_id: string, group_id: string, origin: string): Promise<GroupResource> {
  return group_resource(await find_group(server_id, group_id), origin);
}

export async function create_group(server_id: string, input: GroupInput, origin: string): Promise<GroupResource> {
  const display_name = String(input.displayName ?? "").trim();
  if (!display_name) {
    throw new ScimServiceError("group_display_name_required", "displayName is required.");
  }

  const [created] = await db
    .insert(scim_groups)
    .values({
      server_id,
      external_id: input.externalId ? String(input.externalId) : null,
      display_name,
    })
    .returning();
  try {
    await replace_group_members(server_id, created!.id, input.members ?? []);
  } catch (error) {
    await db.delete(scim_groups).where(eq(scim_groups.id, created!.id));
    throw error;
  }
  return group_resource(created!, origin);
}

export async function delete_group(server_id: string, group_id: string): Promise<void> {
  const existing = await find_group(server_id, group_id);
  await db.delete(scim_groups).where(eq(scim_groups.id, existing.id));
}

export async function replace_group(
  server_id: string,
  group_id: string,
  input: GroupInput,
  origin: string,
): Promise<GroupResource> {
  const existing = await find_group(server_id, group_id);
  const display_name = String(input.displayName ?? "").trim();
  if (!display_name) {
    throw new ScimServiceError("group_display_name_required", "displayName is required.");
  }
  await replace_group_members(server_id, existing.id, input.members ?? []);
  const [updated] = await db
    .update(scim_groups)
    .set({
      external_id: input.externalId ? String(input.externalId) : null,
      display_name,
      version: existing.version + 1,
      updated_at: new Date(),
    })
    .where(eq(scim_groups.id, existing.id))
    .returning();
  return group_resource(updated!, origin);
}

export async function patch_group(
  server_id: string,
  group_id: string,
  operations: PatchOperation[],
  origin: string,
): Promise<GroupResource> {
  const existing = await find_group(server_id, group_id);
  let display_name = existing.display_name;
  let external_id = existing.external_id;
  let members: GroupMember[] = (await group_resource(existing, origin)).members;

  for (const operation of operations) {
    const op = operation.op.toLowerCase();
    const path = operation.path || "";
    if (!["add", "replace", "remove"].includes(op)) {
      throw new ScimServiceError("patch_operation_unsupported", "Unsupported PATCH operation.");
    }
    if (!path && operation.value && typeof operation.value === "object") {
      const value = operation.value as DynamicObject;
      if (value.displayName !== undefined) {
        display_name = String(value.displayName);
      }
      if (value.externalId !== undefined) {
        external_id = value.externalId ? String(value.externalId) : null;
      }
      if (value.members !== undefined) {
        members = parse_group_members(value.members);
      }
    } else if (/^displayname$/i.test(path)) {
      display_name = op === "remove" ? "" : String(operation.value ?? "");
    } else if (/^externalid$/i.test(path)) {
      external_id = op === "remove" ? null : String(operation.value ?? "");
    } else if (/^members$/i.test(path)) {
      if (op === "remove") {
        members = [];
      } else {
        const values = parse_group_members(Array.isArray(operation.value) ? operation.value : [operation.value]);
        if (op === "replace") {
          members = values;
        }
        if (op === "add") {
          members = [...members, ...values];
        }
      }
    } else {
      // SCIM clients commonly remove a single member with a value filter.
      const member_filter = path.match(/^members\[value\s+eq\s+"([^"]+)"\]$/i);
      if (member_filter && op === "remove") {
        members = members.filter((member) => member.value !== member_filter[1]);
      } else throw new ScimServiceError("group_patch_path_unsupported", "Unsupported Group PATCH path.");
    }
  }

  if (!display_name.trim()) {
    throw new ScimServiceError("group_patch_removes_display_name", "PATCH cannot remove displayName.");
  }
  await replace_group_members(server_id, existing.id, members);
  const [updated] = await db
    .update(scim_groups)
    .set({
      display_name,
      external_id,
      version: existing.version + 1,
      updated_at: new Date(),
    })
    .where(eq(scim_groups.id, existing.id))
    .returning();
  return group_resource(updated!, origin);
}
