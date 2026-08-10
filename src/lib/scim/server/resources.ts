import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import {
  scim_group_members,
  scim_groups,
  scim_users,
  type ScimGroupRecord,
  type ScimUserRecord,
} from "../../../db/schema.ts";
import { GROUP_SCHEMA_URI, USER_SCHEMA_URI } from "./constants.ts";
import { GroupData, GroupResource, UserData, UserResource, type GroupInput, type UserInput } from "../schemas.ts";

function date_string(value: Date): string {
  return value.toISOString();
}

export function base_url(origin: string, server_id: string): string {
  return `${origin}/scim/${server_id}/v2`;
}

export function clean_user_payload(input: UserInput | UserResource): UserData {
  // Identity fields live in dedicated columns. Keep only extensible SCIM fields
  // in `data` so clients cannot persist computed `groups` or `meta` values.
  const parsed = UserData.parse(input);
  const allowed = new Set([
    "name",
    "nickName",
    "profileUrl",
    "title",
    "userType",
    "preferredLanguage",
    "locale",
    "timezone",
    "emails",
    "phoneNumbers",
    "ims",
    "photos",
    "addresses",
    "entitlements",
    "roles",
    "x509Certificates",
  ]);
  const result = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => allowed.has(key) || key.includes(":")),
  ) as UserData;
  for (const value of Object.values(result)) {
    if (!Array.isArray(value)) continue;
    const primary_index = value.findLastIndex((entry) => entry && typeof entry === "object" && entry.primary === true);
    if (primary_index >= 0)
      value.forEach((entry, index) => {
        if (entry && typeof entry === "object" && "primary" in entry) entry.primary = index === primary_index;
      });
  }
  const enterprise = result["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"];
  if (enterprise?.manager) delete enterprise.manager.displayName;
  return (prune_unassigned(result) ?? {}) as UserData;
}

export function clean_group_payload(input: GroupInput | GroupResource): GroupData {
  return (prune_unassigned(Object.fromEntries(Object.entries(input).filter(([key]) => key.includes(":")))) ??
    {}) as GroupData;
}

function prune_unassigned(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(prune_unassigned).filter((entry) => entry !== undefined);
    return entries.length ? entries : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, entry]) => [key, prune_unassigned(entry)] as const)
      .filter(([, entry]) => entry !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null || value === "" ? undefined : value;
}

function resource_schemas(core_schema: string, data: Record<string, unknown>): string[] {
  return [
    core_schema,
    ...Object.keys(data).filter((key) => key.includes(":") && data[key] != null && key !== core_schema),
  ];
}

export async function user_resource(row: ScimUserRecord, origin: string): Promise<UserResource> {
  const direct_rows = await db
    .select({ group: scim_groups })
    .from(scim_group_members)
    .innerJoin(scim_groups, eq(scim_group_members.group_id, scim_groups.id))
    .where(and(eq(scim_group_members.member_type, "User"), eq(scim_group_members.member_id, row.id)));
  const memberships = direct_rows.map(({ group }) => ({ group, type: "direct" }));
  const seen = new Set(direct_rows.map(({ group }) => group.id));
  let frontier = [...seen];
  while (frontier.length) {
    const parents = await db
      .select({ group: scim_groups })
      .from(scim_group_members)
      .innerJoin(scim_groups, eq(scim_group_members.group_id, scim_groups.id))
      .where(
        and(
          eq(scim_group_members.member_type, "Group"),
          inArray(scim_group_members.member_id, frontier),
          eq(scim_groups.server_id, row.server_id),
        ),
      );
    frontier = [];
    for (const { group } of parents) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      frontier.push(group.id);
      memberships.push({ group, type: "indirect" });
    }
  }
  const groups = memberships.map(({ group, type }) => ({
    value: group.id,
    display: group.display_name,
    type,
    $ref: `${base_url(origin, row.server_id)}/Groups/${group.id}`,
  }));
  return UserResource.parse({
    schemas: resource_schemas(USER_SCHEMA_URI, row.data),
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    active: row.active,
    ...UserData.parse(row.data),
    ...(groups.length ? { groups } : {}),
    meta: {
      resourceType: "User",
      created: date_string(row.created_at),
      lastModified: date_string(row.updated_at),
      version: `W/\"${row.version}\"`,
      location: `${base_url(origin, row.server_id)}/Users/${row.id}`,
    },
  });
}

export async function group_resource(row: ScimGroupRecord, origin: string): Promise<GroupResource> {
  const memberships = await db.select().from(scim_group_members).where(eq(scim_group_members.group_id, row.id));
  const user_ids = memberships.filter((member) => member.member_type === "User").map((member) => member.member_id);
  const group_ids = memberships.filter((member) => member.member_type === "Group").map((member) => member.member_id);
  const users = user_ids.length ? await db.select().from(scim_users).where(inArray(scim_users.id, user_ids)) : [];
  const groups = group_ids.length ? await db.select().from(scim_groups).where(inArray(scim_groups.id, group_ids)) : [];
  const members = memberships.flatMap((membership) => {
    const member =
      membership.member_type === "Group"
        ? groups.find((group) => group.id === membership.member_id)
        : users.find((user) => user.id === membership.member_id);
    if (!member) return [];
    const display = "display_name" in member ? member.display_name : null;
    return [
      {
        value: member.id,
        type: membership.member_type,
        display: display ?? ("user_name" in member ? member.user_name : undefined),
        $ref: `${base_url(origin, row.server_id)}/${membership.member_type}s/${member.id}`,
      },
    ];
  });

  return GroupResource.parse({
    schemas: resource_schemas(GROUP_SCHEMA_URI, row.data),
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    displayName: row.display_name,
    ...GroupData.parse(row.data),
    ...(members.length ? { members } : {}),
    meta: {
      resourceType: "Group",
      created: date_string(row.created_at),
      lastModified: date_string(row.updated_at),
      version: `W/\"${row.version}\"`,
      location: `${base_url(origin, row.server_id)}/Groups/${row.id}`,
    },
  });
}
