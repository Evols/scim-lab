import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { app_config } from "../lib/config";
import {
  decrypt_secret,
  encrypt_secret,
  generated_basic_username,
  generated_bearer_token,
  hash_secret,
  random_secret,
} from "../lib/crypto";
import {
  console_sessions,
  console_flashes,
  console_users,
  oidc_transactions,
  scim_events,
  scim_group_members,
  scim_groups,
  scim_servers,
  scim_users,
  server_members,
  share_invites,
  type console_user_record,
  type scim_server_record,
} from "./schema";

const query_client = postgres(app_config.database_url, { max: 10 });
export const db = drizzle({ client: query_client });

export interface ConsoleContext {
  user: console_user_record;
  session_token?: string;
  fresh_server?: scim_server_record;
}

export interface ServerCredential {
  auth_mode: "bearer" | "basic";
  username: string | null;
  credential: string;
}

export type ServerLifecycle = "active" | "deactivated" | "expired";

export function get_server_lifecycle(
  server: scim_server_record,
  is_anonymous: boolean,
  now = new Date(),
): ServerLifecycle {
  const inactive_ms = now.getTime() - server.last_console_access_at.getTime();
  const active_window_ms = (is_anonymous ? 7 : 30) * 86_400_000;
  const deactivated_at =
    server.deactivated_at ??
    new Date(server.last_console_access_at.getTime() + active_window_ms);
  if (inactive_ms < active_window_ms && !server.deactivated_at) return "active";
  const recovery_ms = (is_anonymous ? 30 : 90) * 86_400_000;
  return now.getTime() <= deactivated_at.getTime() + recovery_ms
    ? "deactivated"
    : "expired";
}

export async function find_console_session(
  raw_token: string,
): Promise<ConsoleContext | null> {
  const token_hash = hash_secret(raw_token);
  const rows = await db
    .select({ session: console_sessions, user: console_users })
    .from(console_sessions)
    .innerJoin(console_users, eq(console_sessions.user_id, console_users.id))
    .where(
      and(
        eq(console_sessions.token_hash, token_hash),
        gt(console_sessions.expires_at, new Date()),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  await db
    .update(console_sessions)
    .set({
      last_seen_at: new Date(),
      expires_at: new Date(
        Date.now() + (rows[0].user.is_anonymous ? 37 : 30) * 86_400_000,
      ),
    })
    .where(eq(console_sessions.token_hash, token_hash));
  return { user: rows[0].user };
}

export async function create_anonymous_context(): Promise<ConsoleContext> {
  const session_token = random_secret();
  const bearer_token = generated_bearer_token();
  return db.transaction(async (transaction) => {
    const [user] = await transaction
      .insert(console_users)
      .values({})
      .returning();
    if (!user) throw new Error("Unable to create anonymous console user.");
    await transaction.insert(console_sessions).values({
      token_hash: hash_secret(session_token),
      user_id: user.id,
      expires_at: new Date(Date.now() + 37 * 86_400_000),
    });
    const [server] = await transaction
      .insert(scim_servers)
      .values({
        name: "My SCIM server",
        created_by_user_id: user.id,
        bearer_token_hash: hash_secret(bearer_token),
        bearer_token_encrypted: encrypt_secret(bearer_token),
      })
      .returning();
    if (!server) throw new Error("Unable to create the default SCIM server.");
    await transaction
      .insert(server_members)
      .values({ server_id: server.id, user_id: user.id });
    return { user, session_token, fresh_server: server };
  });
}

export async function replace_session(user_id: string): Promise<string> {
  const session_token = random_secret();
  await db.transaction(async (transaction) => {
    await transaction
      .delete(console_sessions)
      .where(eq(console_sessions.user_id, user_id));
    await transaction.insert(console_sessions).values({
      token_hash: hash_secret(session_token),
      user_id,
      expires_at: new Date(Date.now() + 30 * 86_400_000),
    });
  });
  return session_token;
}

export async function delete_session(raw_token: string): Promise<void> {
  await db
    .delete(console_sessions)
    .where(eq(console_sessions.token_hash, hash_secret(raw_token)));
}

export async function create_flash(
  user_id: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const token = random_secret();
  await db.insert(console_flashes).values({
    token_hash: hash_secret(token),
    user_id,
    payload,
    expires_at: new Date(Date.now() + 5 * 60_000),
  });
  return token;
}

export async function take_flash(
  user_id: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(console_flashes)
      .where(
        and(
          eq(console_flashes.token_hash, hash_secret(token)),
          eq(console_flashes.user_id, user_id),
          gt(console_flashes.expires_at, new Date()),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    await transaction
      .delete(console_flashes)
      .where(eq(console_flashes.token_hash, rows[0].token_hash));
    return rows[0].payload;
  });
}

export async function list_servers_for_user(user_id: string) {
  const rows = await db
    .select({ server: scim_servers, creator: console_users })
    .from(server_members)
    .innerJoin(scim_servers, eq(server_members.server_id, scim_servers.id))
    .innerJoin(
      console_users,
      eq(scim_servers.created_by_user_id, console_users.id),
    )
    .where(eq(server_members.user_id, user_id))
    .orderBy(desc(scim_servers.created_at));
  const expired_ids = rows
    .filter(
      ({ server, creator }) =>
        get_server_lifecycle(server, creator.is_anonymous) === "expired",
    )
    .map(({ server }) => server.id);
  if (expired_ids.length)
    await db.delete(scim_servers).where(inArray(scim_servers.id, expired_ids));
  return rows.filter(({ server }) => !expired_ids.includes(server.id));
}

export async function get_server_for_user(user_id: string, server_id: string) {
  const rows = await db
    .select({ server: scim_servers, creator: console_users })
    .from(server_members)
    .innerJoin(scim_servers, eq(server_members.server_id, scim_servers.id))
    .innerJoin(
      console_users,
      eq(scim_servers.created_by_user_id, console_users.id),
    )
    .where(
      and(
        eq(server_members.user_id, user_id),
        eq(server_members.server_id, server_id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function touch_server_console(server_id: string): Promise<void> {
  await db
    .update(scim_servers)
    .set({
      last_console_access_at: new Date(),
      deactivated_at: null,
      updated_at: new Date(),
    })
    .where(eq(scim_servers.id, server_id));
}

export async function mark_server_deactivated(
  server: scim_server_record,
  is_anonymous: boolean,
): Promise<scim_server_record> {
  const lifecycle = get_server_lifecycle(server, is_anonymous);
  if (lifecycle === "active" || server.deactivated_at) return server;
  const active_days = is_anonymous ? 7 : 30;
  const deactivated_at = new Date(
    server.last_console_access_at.getTime() + active_days * 86_400_000,
  );
  const [updated] = await db
    .update(scim_servers)
    .set({ deactivated_at, updated_at: new Date() })
    .where(eq(scim_servers.id, server.id))
    .returning();
  return updated ?? server;
}

export async function reactivate_server(
  user_id: string,
  server_id: string,
): Promise<boolean> {
  const access = await get_server_for_user(user_id, server_id);
  if (
    !access ||
    access.creator.is_anonymous ||
    get_server_lifecycle(access.server, false) === "expired"
  )
    return false;
  await touch_server_console(server_id);
  return true;
}

export async function create_server(user_id: string, name: string) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${user_id}))`,
    );
    const [{ value }] = await transaction
      .select({ value: count() })
      .from(scim_servers)
      .where(eq(scim_servers.created_by_user_id, user_id));
    if (Number(value) >= 3)
      throw new Error("You can create at most three SCIM servers.");
    const bearer_token = generated_bearer_token();
    const [server] = await transaction
      .insert(scim_servers)
      .values({
        name: name.slice(0, 80) || "Untitled SCIM server",
        created_by_user_id: user_id,
        bearer_token_hash: hash_secret(bearer_token),
        bearer_token_encrypted: encrypt_secret(bearer_token),
      })
      .returning();
    if (!server) throw new Error("Unable to create SCIM server.");
    await transaction
      .insert(server_members)
      .values({ server_id: server.id, user_id });
    return { server };
  });
}

export async function read_server_credential(
  user_id: string,
  server_id: string,
): Promise<ServerCredential> {
  const access = await get_server_for_user(user_id, server_id);
  if (!access) throw new Error("Server not found.");
  if (access.server.auth_mode === "basic") {
    if (!access.server.basic_password_encrypted) {
      throw new Error(
        "This credential predates recoverable storage. Generate new Basic credentials in Settings.",
      );
    }
    return {
      auth_mode: "basic",
      username: access.server.basic_username,
      credential: decrypt_secret(access.server.basic_password_encrypted),
    };
  }
  if (!access.server.bearer_token_encrypted) {
    throw new Error(
      "This credential predates recoverable storage. Generate a new bearer token in Settings.",
    );
  }
  return {
    auth_mode: "bearer",
    username: null,
    credential: decrypt_secret(access.server.bearer_token_encrypted),
  };
}

export async function rename_server(
  user_id: string,
  server_id: string,
  name: string,
): Promise<void> {
  const access = await get_server_for_user(user_id, server_id);
  if (!access) throw new Error("Server not found.");
  await db
    .update(scim_servers)
    .set({ name: name.slice(0, 80), updated_at: new Date() })
    .where(eq(scim_servers.id, server_id));
}

export async function delete_server(
  user_id: string,
  server_id: string,
): Promise<void> {
  const access = await get_server_for_user(user_id, server_id);
  if (!access) throw new Error("Server not found.");
  await db.delete(scim_servers).where(eq(scim_servers.id, server_id));
}

export async function rotate_server_auth(
  user_id: string,
  server_id: string,
  auth_mode: "bearer" | "basic",
) {
  const access = await get_server_for_user(user_id, server_id);
  if (!access) throw new Error("Server not found.");
  if (auth_mode === "bearer") {
    const credential = generated_bearer_token();
    await db
      .update(scim_servers)
      .set({
        auth_mode,
        bearer_token_hash: hash_secret(credential),
        bearer_token_encrypted: encrypt_secret(credential),
        basic_username: null,
        basic_password_hash: null,
        basic_password_encrypted: null,
        credential_rotated_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(scim_servers.id, server_id));
    return;
  }
  const username = generated_basic_username(server_id);
  const credential = random_secret(24);
  await db
    .update(scim_servers)
    .set({
      auth_mode,
      bearer_token_hash: null,
      bearer_token_encrypted: null,
      basic_username: username,
      basic_password_hash: hash_secret(credential),
      basic_password_encrypted: encrypt_secret(credential),
      credential_rotated_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(scim_servers.id, server_id));
}

export async function create_share_invite(user_id: string, server_id: string) {
  const access = await get_server_for_user(user_id, server_id);
  const callers = await db
    .select()
    .from(console_users)
    .where(eq(console_users.id, user_id))
    .limit(1);
  if (!access || callers[0]?.is_anonymous !== false)
    throw new Error("Sign in before sharing a server.");
  const token = random_secret();
  await db.insert(share_invites).values({
    token_hash: hash_secret(token),
    server_id,
    created_by_user_id: user_id,
    expires_at: new Date(Date.now() + 30 * 86_400_000),
  });
  return token;
}

export async function list_share_invites(server_id: string) {
  return db
    .select()
    .from(share_invites)
    .where(
      and(
        eq(share_invites.server_id, server_id),
        isNull(share_invites.revoked_at),
      ),
    )
    .orderBy(desc(share_invites.created_at));
}

export async function revoke_share_invite(
  user_id: string,
  server_id: string,
  token_hash: string,
): Promise<void> {
  const access = await get_server_for_user(user_id, server_id);
  if (!access) throw new Error("Server not found.");
  await db
    .update(share_invites)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(share_invites.server_id, server_id),
        eq(share_invites.token_hash, token_hash),
      ),
    );
}

export async function get_share_invite(token: string) {
  const rows = await db
    .select({ invite: share_invites, server: scim_servers })
    .from(share_invites)
    .innerJoin(scim_servers, eq(share_invites.server_id, scim_servers.id))
    .where(
      and(
        eq(share_invites.token_hash, hash_secret(token)),
        isNull(share_invites.revoked_at),
        gt(share_invites.expires_at, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function accept_share_invite(
  user_id: string,
  token: string,
): Promise<string> {
  const match = await get_share_invite(token);
  if (!match) throw new Error("This sharing link is invalid or expired.");
  await db
    .insert(server_members)
    .values({ server_id: match.server.id, user_id })
    .onConflictDoNothing();
  return match.server.id;
}

export async function save_oidc_transaction(
  user_id: string,
  state: string,
  code_verifier: string,
  nonce: string,
  return_to: string,
): Promise<void> {
  await db.insert(oidc_transactions).values({
    state_hash: hash_secret(state),
    user_id,
    code_verifier,
    nonce,
    return_to,
    expires_at: new Date(Date.now() + 10 * 60_000),
  });
}

export async function take_oidc_transaction(state: string) {
  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(oidc_transactions)
      .where(
        and(
          eq(oidc_transactions.state_hash, hash_secret(state)),
          gt(oidc_transactions.expires_at, new Date()),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    await transaction
      .delete(oidc_transactions)
      .where(eq(oidc_transactions.state_hash, rows[0].state_hash));
    return rows[0];
  });
}

export async function complete_oidc_login(
  anonymous_user_id: string,
  identity: {
    issuer: string;
    subject: string;
    email?: string;
    display_name?: string;
  },
): Promise<console_user_record> {
  return db.transaction(async (transaction) => {
    const existing = await transaction
      .select()
      .from(console_users)
      .where(
        and(
          eq(console_users.oidc_issuer, identity.issuer),
          eq(console_users.oidc_subject, identity.subject),
        ),
      )
      .limit(1);
    if (!existing[0] || existing[0].id === anonymous_user_id) {
      const [upgraded] = await transaction
        .update(console_users)
        .set({
          is_anonymous: false,
          oidc_issuer: identity.issuer,
          oidc_subject: identity.subject,
          email: identity.email,
          display_name: identity.display_name,
          upgraded_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(console_users.id, anonymous_user_id))
        .returning();
      if (!upgraded) throw new Error("Unable to upgrade account.");
      await transaction
        .update(scim_servers)
        .set({
          deactivated_at: null,
          last_console_access_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(scim_servers.created_by_user_id, upgraded.id));
      return upgraded;
    }
    const target = existing[0];
    const anonymous_memberships = await transaction
      .select()
      .from(server_members)
      .where(eq(server_members.user_id, anonymous_user_id));
    if (anonymous_memberships.length) {
      await transaction
        .insert(server_members)
        .values(
          anonymous_memberships.map((membership) => ({
            server_id: membership.server_id,
            user_id: target.id,
          })),
        )
        .onConflictDoNothing();
    }
    await transaction
      .update(scim_servers)
      .set({
        created_by_user_id: target.id,
        deactivated_at: null,
        last_console_access_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(scim_servers.created_by_user_id, anonymous_user_id));
    await transaction
      .delete(server_members)
      .where(eq(server_members.user_id, anonymous_user_id));
    await transaction
      .delete(console_sessions)
      .where(eq(console_sessions.user_id, anonymous_user_id));
    await transaction
      .delete(console_users)
      .where(eq(console_users.id, anonymous_user_id));
    return target;
  });
}

export async function get_console_counts(server_id: string) {
  const [[users_count], [groups_count], [events_count]] = await Promise.all([
    db
      .select({ value: count() })
      .from(scim_users)
      .where(eq(scim_users.server_id, server_id)),
    db
      .select({ value: count() })
      .from(scim_groups)
      .where(eq(scim_groups.server_id, server_id)),
    db
      .select({ value: count() })
      .from(scim_events)
      .where(
        and(
          eq(scim_events.server_id, server_id),
          gt(scim_events.created_at, new Date(Date.now() - 30 * 86_400_000)),
        ),
      ),
  ]);
  return {
    users: Number(users_count?.value ?? 0),
    groups: Number(groups_count?.value ?? 0),
    events: Number(events_count?.value ?? 0),
  };
}

export async function list_console_users(server_id: string) {
  return db
    .select()
    .from(scim_users)
    .where(eq(scim_users.server_id, server_id))
    .orderBy(asc(scim_users.user_name));
}

export async function list_console_groups(server_id: string) {
  const groups = await db
    .select()
    .from(scim_groups)
    .where(eq(scim_groups.server_id, server_id))
    .orderBy(asc(scim_groups.display_name));
  const group_ids = groups.map((group) => group.id);
  const members = group_ids.length
    ? await db
        .select()
        .from(scim_group_members)
        .where(inArray(scim_group_members.group_id, group_ids))
    : [];
  return groups.map((group) => ({
    ...group,
    member_count: members.filter((member) => member.group_id === group.id)
      .length,
  }));
}

export async function list_console_events(
  server_id: string,
  status_filter?: string,
  method_filter?: string,
) {
  await prune_events(server_id);
  const conditions = [
    eq(scim_events.server_id, server_id),
    gt(scim_events.created_at, new Date(Date.now() - 30 * 86_400_000)),
  ];
  if (status_filter === "success") conditions.push(lt(scim_events.status, 400));
  if (status_filter === "error")
    conditions.push(sql`${scim_events.status} >= 400`);
  if (
    method_filter &&
    ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method_filter)
  )
    conditions.push(eq(scim_events.method, method_filter));
  return db
    .select()
    .from(scim_events)
    .where(and(...conditions))
    .orderBy(desc(scim_events.created_at))
    .limit(200);
}

export async function prune_events(server_id: string): Promise<void> {
  await db
    .delete(scim_events)
    .where(
      and(
        eq(scim_events.server_id, server_id),
        lt(scim_events.created_at, new Date(Date.now() - 30 * 86_400_000)),
      ),
    );
  await db.execute(sql`
		delete from ${scim_events}
		where ${scim_events.server_id} = ${server_id}
		and ${scim_events.id} not in (
			select ${scim_events.id} from ${scim_events}
			where ${scim_events.server_id} = ${server_id}
			order by ${scim_events.id} desc limit 1000
		)
	`);
}

export async function purge_expired_records(): Promise<void> {
  await db
    .delete(console_sessions)
    .where(lt(console_sessions.expires_at, new Date()));
  await db
    .delete(console_flashes)
    .where(lt(console_flashes.expires_at, new Date()));
  await db
    .delete(oidc_transactions)
    .where(lt(oidc_transactions.expires_at, new Date()));
  await db
    .delete(share_invites)
    .where(
      or(
        lt(share_invites.expires_at, new Date(Date.now() - 30 * 86_400_000)),
        sql`${share_invites.revoked_at} is not null and ${share_invites.revoked_at} < now() - interval '30 days'`,
      ),
    );
}
