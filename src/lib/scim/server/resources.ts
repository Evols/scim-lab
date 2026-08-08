import { eq } from "drizzle-orm";
import { db } from "../../../db";
import {
  scim_group_members,
  scim_groups,
  scim_users,
  type ScimGroupRecord,
  type ScimUserRecord,
} from "../../../db/schema.ts";
import { GROUP_SCHEMA, USER_SCHEMA } from "./constants.ts";
import {
  GroupResourceSchema,
  UserDataSchema,
  UserResourceSchema,
  type GroupResource,
  type UserData,
  type UserResource,
  type UserWriteInput,
} from "../schemas.ts";

function date_string(value: Date): string {
  return value.toISOString();
}

export function base_url(origin: string, server_id: string): string {
  return `${origin}/scim/${server_id}/v2`;
}

export function clean_user_payload(
  input: UserWriteInput | UserResource,
): UserData {
  // Identity fields live in dedicated columns. Keep only extensible SCIM fields
  // in `data` so clients cannot persist computed `groups` or `meta` values.
  return UserDataSchema.parse(input);
}

export async function user_resource(
  row: ScimUserRecord,
  origin: string,
): Promise<UserResource> {
  const membership_rows = await db
    .select({ group: scim_groups })
    .from(scim_group_members)
    .innerJoin(scim_groups, eq(scim_group_members.group_id, scim_groups.id))
    .where(eq(scim_group_members.user_id, row.id));
  return UserResourceSchema.parse({
    schemas: [USER_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    active: row.active,
    ...UserDataSchema.parse(row.data),
    groups: membership_rows.map(({ group }) => ({
      value: group.id,
      display: group.display_name,
      $ref: `${base_url(origin, row.server_id)}/Groups/${group.id}`,
    })),
    meta: {
      resourceType: "User",
      created: date_string(row.created_at),
      lastModified: date_string(row.updated_at),
      version: `W/\"${row.version}\"`,
      location: `${base_url(origin, row.server_id)}/Users/${row.id}`,
    },
  });
}

export async function group_resource(
  row: ScimGroupRecord,
  origin: string,
): Promise<GroupResource> {
  const members = await db
    .select({ user: scim_users })
    .from(scim_group_members)
    .innerJoin(scim_users, eq(scim_group_members.user_id, scim_users.id))
    .where(eq(scim_group_members.group_id, row.id));

  return GroupResourceSchema.parse({
    schemas: [GROUP_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    displayName: row.display_name,
    members: members.map(({ user }) => ({
      value: user.id,
      display: user.display_name ?? user.user_name,
      $ref: `${base_url(origin, row.server_id)}/Users/${user.id}`,
    })),
    meta: {
      resourceType: "Group",
      created: date_string(row.created_at),
      lastModified: date_string(row.updated_at),
      version: `W/\"${row.version}\"`,
      location: `${base_url(origin, row.server_id)}/Groups/${row.id}`,
    },
  });
}
