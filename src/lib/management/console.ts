import { and, asc, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { scim_events, scim_group_members, scim_groups, scim_users } from "../../db/schema.ts";
import type { Database } from "../database.ts";

export async function get_console_counts(server_id: string, database: Database) {
  const [[users_count], [groups_count], [events_count]] = await Promise.all([
    database.select({ value: count() }).from(scim_users).where(eq(scim_users.server_id, server_id)),
    database.select({ value: count() }).from(scim_groups).where(eq(scim_groups.server_id, server_id)),
    database
      .select({ value: count() })
      .from(scim_events)
      .where(
        and(eq(scim_events.server_id, server_id), gt(scim_events.created_at, new Date(Date.now() - 30 * 86_400_000))),
      ),
  ]);
  return {
    users: Number(users_count?.value ?? 0),
    groups: Number(groups_count?.value ?? 0),
    events: Number(events_count?.value ?? 0),
  };
}

export async function list_console_users(server_id: string, database: Database) {
  return database
    .select()
    .from(scim_users)
    .where(eq(scim_users.server_id, server_id))
    .orderBy(asc(scim_users.user_name));
}

export async function list_console_groups(server_id: string, database: Database) {
  const groups = await database
    .select()
    .from(scim_groups)
    .where(eq(scim_groups.server_id, server_id))
    .orderBy(asc(scim_groups.display_name));
  const group_ids = groups.map((group) => group.id);
  const members = group_ids.length
    ? await database.select().from(scim_group_members).where(inArray(scim_group_members.group_id, group_ids))
    : [];
  return groups.map((group) => ({
    ...group,
    member_count: members.filter((member) => member.group_id === group.id).length,
  }));
}

export async function list_console_events(
  server_id: string,
  status_filter: string | undefined,
  method_filter: string | undefined,
  database: Database,
) {
  await prune_events(server_id, database);
  const conditions = [
    eq(scim_events.server_id, server_id),
    gt(scim_events.created_at, new Date(Date.now() - 30 * 86_400_000)),
  ];
  if (status_filter === "success") {
    conditions.push(lt(scim_events.status, 400));
  }
  if (status_filter === "error") {
    conditions.push(sql`${scim_events.status} >= 400`);
  }
  if (method_filter && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method_filter)) {
    conditions.push(eq(scim_events.method, method_filter));
  }
  return database
    .select()
    .from(scim_events)
    .where(and(...conditions))
    .orderBy(desc(scim_events.created_at))
    .limit(200);
}

export async function prune_events(server_id: string, database: Database): Promise<void> {
  await database
    .delete(scim_events)
    .where(
      and(eq(scim_events.server_id, server_id), lt(scim_events.created_at, new Date(Date.now() - 30 * 86_400_000))),
    );
  await database.execute(sql`
    delete from ${scim_events}
    where ${scim_events.server_id} = ${server_id}
    and ${scim_events.id} not in (
      select ${scim_events.id} from ${scim_events}
      where ${scim_events.server_id} = ${server_id}
      order by ${scim_events.id} desc limit 1000
    )
  `);
}
