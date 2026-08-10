import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "../../database";
import { scim_group_members, scim_users } from "../../../db/schema.ts";
import { matches_filter } from "./filter.ts";
import { paginate, type ListQuery } from "./pagination.ts";
import { sort_resources } from "./query.ts";
import {
  UserResource as UserResourceSchema,
  type PatchOperation,
  type UserInput,
  type UserListResponse,
  type UserResource,
} from "../schemas.ts";
import { ScimServiceError } from "./error.ts";
import { apply_patch } from "./patch.ts";
import { clean_user_payload, user_resource } from "./resources.ts";

async function find_user(server_id: string, user_id: string) {
  const rows = await db
    .select()
    .from(scim_users)
    .where(and(eq(scim_users.server_id, server_id), eq(scim_users.id, user_id)))
    .limit(1);
  if (!rows[0]) {
    throw new ScimServiceError("user_not_found", "User not found.");
  }
  return rows[0];
}

function prepared_user_name(value: unknown): string {
  const user_name = String(value ?? "").normalize("NFKC");
  if (/\s|[\u0000-\u001f\u007f]/u.test(user_name)) return "";
  return user_name;
}

function database_error_code(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } };
  return value.code ?? value.cause?.code;
}

export async function query_users(server_id: string, origin: string, query: ListQuery): Promise<UserResource[]> {
  const rows = await db
    .select()
    .from(scim_users)
    .where(eq(scim_users.server_id, server_id))
    .orderBy(asc(scim_users.created_at));
  let resources = await Promise.all(rows.map((row) => user_resource(row, origin)));
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

export async function list_users(server_id: string, origin: string, query: ListQuery): Promise<UserListResponse> {
  return paginate(await query_users(server_id, origin, query), query);
}

export async function get_user(server_id: string, user_id: string, origin: string): Promise<UserResource> {
  return user_resource(await find_user(server_id, user_id), origin);
}

export async function create_user(server_id: string, input: UserInput, origin: string): Promise<UserResource> {
  const user_name = prepared_user_name(input.userName);
  if (!user_name) {
    throw new ScimServiceError("user_name_required", "userName is required.");
  }

  return db.transaction(async (transaction) => {
    // Serialize the count and insert per server so concurrent requests cannot
    // both observe room below the 100-user cap.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${server_id}))`);
    const [{ value }] = await transaction
      .select({ value: count() })
      .from(scim_users)
      .where(eq(scim_users.server_id, server_id));
    if (Number(value) >= 100) {
      throw new ScimServiceError("user_limit_reached", "This server has reached its 100-user limit.");
    }

    try {
      const [created] = await transaction
        .insert(scim_users)
        .values({
          server_id,
          external_id: input.externalId ? String(input.externalId) : null,
          user_name,
          display_name: input.displayName ? String(input.displayName) : null,
          active: input.active == null ? true : input.active,
          data: clean_user_payload(input),
        })
        .returning();
      return user_resource(created!, origin);
    } catch (error) {
      if (database_error_code(error) === "23505") {
        throw new ScimServiceError("user_name_not_unique", "userName must be unique.");
      }
      throw error;
    }
  });
}

export async function delete_user(server_id: string, user_id: string): Promise<void> {
  const existing = await find_user(server_id, user_id);
  await db.transaction(async (transaction) => {
    await transaction
      .delete(scim_group_members)
      .where(and(eq(scim_group_members.member_type, "User"), eq(scim_group_members.member_id, existing.id)));
    const deleted = await transaction
      .delete(scim_users)
      .where(and(eq(scim_users.id, existing.id), eq(scim_users.version, existing.version)))
      .returning({ id: scim_users.id });
    if (!deleted.length) throw new ScimServiceError("resource_version_conflict", "The User changed concurrently.");
  });
}

export async function replace_user(
  server_id: string,
  user_id: string,
  input: UserInput,
  origin: string,
): Promise<UserResource> {
  const existing = await find_user(server_id, user_id);
  const user_name = prepared_user_name(input.userName);
  if (!user_name) {
    throw new ScimServiceError("user_name_required", "userName is required.");
  }

  try {
    const [updated] = await db
      .update(scim_users)
      .set({
        external_id: input.externalId ? String(input.externalId) : null,
        user_name,
        display_name: input.displayName ? String(input.displayName) : null,
        active: input.active == null ? true : input.active,
        data: clean_user_payload(input),
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(and(eq(scim_users.id, existing.id), eq(scim_users.version, existing.version)))
      .returning();
    if (!updated) throw new ScimServiceError("resource_version_conflict", "The User changed concurrently.");
    return user_resource(updated!, origin);
  } catch (error) {
    if (database_error_code(error) === "23505") {
      throw new ScimServiceError("user_name_not_unique", "userName must be unique.");
    }
    throw error;
  }
}

export async function patch_user(
  server_id: string,
  user_id: string,
  operations: PatchOperation[],
  origin: string,
): Promise<UserResource> {
  const existing = await find_user(server_id, user_id);
  const patched = apply_patch(await user_resource(existing, origin), operations);
  if (patched.active == null) patched.active = true;
  const validation = UserResourceSchema.safeParse(patched);
  if (!validation.success) {
    throw new ScimServiceError("patch_value_invalid", "PATCH produced an invalid User attribute value.");
  }
  const resource = validation.data;

  const user_name = prepared_user_name(resource.userName);
  if (!user_name) {
    throw new ScimServiceError("user_patch_removes_user_name", "PATCH cannot remove userName.");
  }
  try {
    const [updated] = await db
      .update(scim_users)
      .set({
        external_id: resource.externalId ? String(resource.externalId) : null,
        user_name,
        display_name: resource.displayName ? String(resource.displayName) : null,
        active: resource.active === undefined ? true : Boolean(resource.active),
        data: clean_user_payload(resource),
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(and(eq(scim_users.id, existing.id), eq(scim_users.version, existing.version)))
      .returning();
    if (!updated) throw new ScimServiceError("resource_version_conflict", "The User changed concurrently.");
    return user_resource(updated!, origin);
  } catch (error) {
    if (database_error_code(error) === "23505") {
      throw new ScimServiceError("user_name_not_unique", "userName must be unique.");
    }
    throw error;
  }
}
