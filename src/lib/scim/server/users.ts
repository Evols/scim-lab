import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { scim_users } from "../../../db/schema.ts";
import { matches_filter } from "./filter.ts";
import { paginate, type ListQuery } from "./pagination.ts";
import type {
  PatchOperation,
  UserListResponse,
  UserResource,
  UserWriteInput,
} from "../schemas.ts";
import { ScimServiceError } from "./error.ts";
import { merge_patch_value } from "./patch.ts";
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

export async function list_users(
  server_id: string,
  origin: string,
  query: ListQuery,
): Promise<UserListResponse> {
  const rows = await db
    .select()
    .from(scim_users)
    .where(eq(scim_users.server_id, server_id))
    .orderBy(asc(scim_users.created_at));
  let resources = await Promise.all(
    rows.map((row) => user_resource(row, origin)),
  );
  if (query.filter) {
    const filter = query.filter;
    try {
      resources = resources.filter((resource) =>
        matches_filter(resource, filter),
      );
    } catch {
      throw new ScimServiceError(
        "filter_invalid",
        "The supplied filter is invalid or unsupported.",
      );
    }
  }
  return paginate(resources, query);
}

export async function get_user(
  server_id: string,
  user_id: string,
  origin: string,
): Promise<UserResource> {
  return user_resource(await find_user(server_id, user_id), origin);
}

export async function create_user(
  server_id: string,
  input: UserWriteInput,
  origin: string,
): Promise<UserResource> {
  const user_name = String(input.userName ?? "").trim();
  if (!user_name) {
    throw new ScimServiceError("user_name_required", "userName is required.");
  }

  return db.transaction(async (transaction) => {
    // Serialize the count and insert per server so concurrent requests cannot
    // both observe room below the 100-user cap.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${server_id}))`,
    );
    const [{ value }] = await transaction
      .select({ value: count() })
      .from(scim_users)
      .where(eq(scim_users.server_id, server_id));
    if (Number(value) >= 100) {
      throw new ScimServiceError(
        "user_limit_reached",
        "This server has reached its 100-user limit.",
      );
    }

    try {
      const [created] = await transaction
        .insert(scim_users)
        .values({
          server_id,
          external_id: input.externalId ? String(input.externalId) : null,
          user_name,
          display_name: input.displayName ? String(input.displayName) : null,
          active: input.active === undefined ? true : Boolean(input.active),
          data: clean_user_payload(input),
        })
        .returning();
      return user_resource(created!, origin);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ScimServiceError(
          "user_name_not_unique",
          "userName must be unique.",
        );
      }
      throw error;
    }
  });
}

export async function delete_user(
  server_id: string,
  user_id: string,
): Promise<void> {
  const existing = await find_user(server_id, user_id);
  await db.delete(scim_users).where(eq(scim_users.id, existing.id));
}

export async function replace_user(
  server_id: string,
  user_id: string,
  input: UserWriteInput,
  origin: string,
): Promise<UserResource> {
  const existing = await find_user(server_id, user_id);
  const user_name = String(input.userName ?? "").trim();
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
        active: input.active === undefined ? true : Boolean(input.active),
        data: clean_user_payload(input),
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(eq(scim_users.id, existing.id))
      .returning();
    return user_resource(updated!, origin);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ScimServiceError(
        "user_name_not_unique",
        "userName must be unique.",
      );
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
  let resource = await user_resource(existing, origin);
  for (const operation of operations) {
    const op = operation.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) {
      throw new ScimServiceError(
        "patch_operation_unsupported",
        "Unsupported PATCH operation.",
      );
    }
    resource = merge_patch_value(
      resource,
      operation.path || undefined,
      operation.value,
      op,
    );
  }

  const user_name = String(resource.userName ?? "").trim();
  if (!user_name) {
    throw new ScimServiceError(
      "user_patch_removes_user_name",
      "PATCH cannot remove userName.",
    );
  }
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
    .where(eq(scim_users.id, existing.id))
    .returning();
  return user_resource(updated!, origin);
}
