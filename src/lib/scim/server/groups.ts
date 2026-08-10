import { and, asc, eq, inArray } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db } from "../../database";
import type { Database } from "../../database";
import { scim_group_members, scim_groups, scim_users } from "../../../db/schema.ts";
import { matches_filter } from "./filter.ts";
import { paginate, type ListQuery } from "./pagination.ts";
import { apply_patch } from "./patch.ts";
import { sort_resources } from "./query.ts";
import {
  GroupResource as GroupResourceSchema,
  GroupMember,
  type GroupInput,
  type GroupListResponse,
  type GroupResource,
  type PatchOperation,
} from "../schemas.ts";
import { ScimServiceError } from "./error.ts";
import { clean_group_payload, group_resource } from "./resources.ts";

type NormalizedGroupMember = { id: string; type: "Group" | "User" };

function normalize_group_members(members: GroupMember[]): NormalizedGroupMember[] {
  return [
    ...new Map(
      members.map((member) => {
        const type = member.type?.toLowerCase() === "group" ? "Group" : "User";
        return [`${type}:${member.value}`, { id: member.value, type }] as const;
      }),
    ).values(),
  ].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

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

async function replace_group_members(
  server_id: string,
  group_id: string,
  members: GroupMember[],
  database: Database,
): Promise<void> {
  const normalized = normalize_group_members(members);
  const user_ids = normalized.filter((member) => member.type === "User").map((member) => member.id);
  const group_ids = normalized.filter((member) => member.type === "Group").map((member) => member.id);

  // Validate the complete replacement before deleting current memberships.
  // This also prevents a group from referencing users on another SCIM server.
  if (user_ids.length) {
    const valid_users = await database
      .select({ id: scim_users.id })
      .from(scim_users)
      .where(and(eq(scim_users.server_id, server_id), inArray(scim_users.id, user_ids)));
    if (valid_users.length !== user_ids.length) {
      throw new ScimServiceError("group_members_invalid", "One or more group members do not exist on this server.");
    }
  }
  if (group_ids.length) {
    const valid_groups = await database
      .select({ id: scim_groups.id })
      .from(scim_groups)
      .where(and(eq(scim_groups.server_id, server_id), inArray(scim_groups.id, group_ids)));
    if (valid_groups.length !== group_ids.length) {
      throw new ScimServiceError("group_members_invalid", "One or more group members do not exist on this server.");
    }
  }
  await database.delete(scim_group_members).where(eq(scim_group_members.group_id, group_id));
  if (normalized.length) {
    await database.insert(scim_group_members).values(
      normalized.map((member) => ({
        group_id,
        member_id: member.id,
        member_type: member.type,
      })),
    );
  }
}

function parse_group_members(value: unknown): GroupMember[] {
  const result = GroupMember.array().safeParse(value);
  if (!result.success) {
    throw new ScimServiceError("group_members_invalid", "Group members must be an array of member objects.");
  }
  return result.data;
}

export async function query_groups(server_id: string, origin: string, query: ListQuery): Promise<GroupResource[]> {
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
  try {
    resources = sort_resources(resources, query.sort_by, query.sort_order);
  } catch {
    throw new ScimServiceError("sort_invalid", "The supplied sort parameters are invalid.");
  }
  return resources;
}

export async function list_groups(server_id: string, origin: string, query: ListQuery): Promise<GroupListResponse> {
  return paginate(await query_groups(server_id, origin, query), query);
}

export async function get_group(server_id: string, group_id: string, origin: string): Promise<GroupResource> {
  return group_resource(await find_group(server_id, group_id), origin);
}

export async function create_group(server_id: string, input: GroupInput, origin: string): Promise<GroupResource> {
  const display_name = String(input.displayName ?? "").trim();
  if (!display_name) {
    throw new ScimServiceError("group_display_name_required", "displayName is required.");
  }

  const created = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .insert(scim_groups)
      .values({
        server_id,
        external_id: input.externalId ? String(input.externalId) : null,
        display_name,
        data: clean_group_payload(input),
      })
      .returning();
    await replace_group_members(server_id, row!.id, input.members ?? [], transaction);
    return row!;
  });
  return group_resource(created!, origin);
}

export async function delete_group(server_id: string, group_id: string): Promise<void> {
  const existing = await find_group(server_id, group_id);
  await db.transaction(async (transaction) => {
    await transaction
      .delete(scim_group_members)
      .where(and(eq(scim_group_members.member_type, "Group"), eq(scim_group_members.member_id, existing.id)));
    const deleted = await transaction
      .delete(scim_groups)
      .where(and(eq(scim_groups.id, existing.id), eq(scim_groups.version, existing.version)))
      .returning({ id: scim_groups.id });
    if (!deleted.length) throw new ScimServiceError("resource_version_conflict", "The Group changed concurrently.");
  });
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
  const updated = await db.transaction(async (transaction) => {
    await replace_group_members(server_id, existing.id, input.members ?? [], transaction);
    const [row] = await transaction
      .update(scim_groups)
      .set({
        external_id: input.externalId ? String(input.externalId) : null,
        display_name,
        data: clean_group_payload(input),
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(and(eq(scim_groups.id, existing.id), eq(scim_groups.version, existing.version)))
      .returning();
    if (!row) throw new ScimServiceError("resource_version_conflict", "The Group changed concurrently.");
    return row;
  });
  return group_resource(updated!, origin);
}

export async function patch_group(
  server_id: string,
  group_id: string,
  operations: PatchOperation[],
  origin: string,
): Promise<GroupResource> {
  const existing = await find_group(server_id, group_id);
  const current = await group_resource(existing, origin);
  const patched = apply_patch(current, operations);
  const validation = GroupResourceSchema.safeParse(patched);
  if (!validation.success) {
    throw new ScimServiceError("patch_value_invalid", "PATCH produced an invalid Group attribute value.");
  }
  const resource = validation.data;
  const display_name = String(resource.displayName ?? "");
  const external_id = resource.externalId ? String(resource.externalId) : null;
  const members = parse_group_members(resource.members ?? []);
  const data = clean_group_payload(resource);
  if (!display_name.trim()) {
    throw new ScimServiceError("group_patch_removes_display_name", "PATCH cannot remove displayName.");
  }
  if (
    display_name === existing.display_name &&
    external_id === existing.external_id &&
    isDeepStrictEqual(data, existing.data) &&
    isDeepStrictEqual(
      normalize_group_members(members),
      normalize_group_members(parse_group_members(current.members ?? [])),
    )
  ) {
    return current;
  }
  const updated = await db.transaction(async (transaction) => {
    await replace_group_members(server_id, existing.id, members, transaction);
    const [row] = await transaction
      .update(scim_groups)
      .set({
        display_name,
        external_id,
        data,
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(and(eq(scim_groups.id, existing.id), eq(scim_groups.version, existing.version)))
      .returning();
    if (!row) throw new ScimServiceError("resource_version_conflict", "The Group changed concurrently.");
    return row;
  });
  return group_resource(updated!, origin);
}
