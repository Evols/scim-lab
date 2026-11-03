import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { anonymous_bootstraps, console_users, scim_servers, server_members } from "../../db/schema.ts";
import type { ConsoleUserRecord, ScimServerRecord } from "../../db/schema.ts";
import { decrypt_secret, encrypt_secret, hash_secret } from "../crypto.ts";
import type { Database } from "../database.ts";
import { APP_CONFIG } from "../config.ts";
import { generated_server_name } from "../management/server-name.ts";

export const DAY_MS = 86_400_000;
export const TOUCH_INTERVAL_MS = 15 * 60_000;
export const ANONYMOUS_COOKIE_PREFIX = "anon_v1.";
const BEARER_PREFIX = "scim_bootstrap_v1.";

const workspace_schema = z.object({
  user_id: z.uuid(),
  server_id: z.uuid(),
  name: z.string().min(1).max(80),
  created_at: z.number().int().nonnegative(),
});
const cookie_schema = z.object({
  purpose: z.literal("anonymous-console-v1"),
  workspace: workspace_schema,
  bearer_token: z.string().startsWith(BEARER_PREFIX).max(2048),
  expires_at: z.number().int(),
});

export type AnonymousWorkspace = z.infer<typeof workspace_schema> & { bearer_token: string };

function recently_issued(created_at: number, now: number, lifetime_days: number): boolean {
  return created_at <= now + 60_000 && now < created_at + lifetime_days * DAY_MS;
}

export function create_provisional_workspace(now = Date.now()): AnonymousWorkspace {
  const workspace = { user_id: randomUUID(), server_id: randomUUID(), name: generated_server_name(), created_at: now };
  const bearer_token = BEARER_PREFIX + encrypt_secret(JSON.stringify({ purpose: "scim-bootstrap-v1", ...workspace }));
  return { ...workspace, bearer_token };
}

export function anonymous_cookie(workspace: AnonymousWorkspace, now = Date.now()): string {
  const { bearer_token, ...metadata } = workspace;
  return (
    ANONYMOUS_COOKIE_PREFIX +
    encrypt_secret(
      JSON.stringify({
        purpose: "anonymous-console-v1",
        workspace: metadata,
        bearer_token,
        expires_at: now + 37 * DAY_MS,
      }),
    )
  );
}

export function read_anonymous_cookie(token: string, now = Date.now()): AnonymousWorkspace | null {
  if (!token.startsWith(ANONYMOUS_COOKIE_PREFIX) || token.length > 4096) return null;
  try {
    const value = cookie_schema.parse(JSON.parse(decrypt_secret(token.slice(ANONYMOUS_COOKIE_PREFIX.length))));
    if (
      value.expires_at <= now ||
      value.expires_at > now + 37 * DAY_MS + 60_000 ||
      value.workspace.created_at > now + 60_000
    )
      return null;
    return { ...value.workspace, bearer_token: value.bearer_token };
  } catch {
    return null;
  }
}

// A SCIM credential cannot be substituted for the console ownership cookie.
export function read_bootstrap_bearer(token: string, server_id: string, now = Date.now()): AnonymousWorkspace | null {
  if (!token.startsWith(BEARER_PREFIX) || token.length > 2048) return null;
  try {
    const value = z
      .object({ purpose: z.literal("scim-bootstrap-v1"), ...workspace_schema.shape })
      .parse(JSON.parse(decrypt_secret(token.slice(BEARER_PREFIX.length))));
    if (value.server_id !== server_id || !recently_issued(value.created_at, now, 7)) return null;
    const { purpose: _purpose, ...workspace } = value;
    return { ...workspace, bearer_token: token };
  } catch {
    return null;
  }
}

export function provisional_records(workspace: AnonymousWorkspace): {
  user: ConsoleUserRecord;
  server: ScimServerRecord;
} {
  const created_at = new Date(workspace.created_at);
  return {
    user: {
      id: workspace.user_id,
      is_anonymous: true,
      oidc_issuer: null,
      oidc_subject: null,
      email: null,
      display_name: null,
      upgraded_at: null,
      created_at,
      updated_at: created_at,
    },
    server: {
      id: workspace.server_id,
      name: workspace.name,
      created_by_user_id: workspace.user_id,
      auth_mode: "bearer",
      bearer_token_hash: hash_secret(workspace.bearer_token),
      bearer_token_encrypted: null,
      basic_username: null,
      basic_password_hash: null,
      basic_password_encrypted: null,
      credential_rotated_at: created_at,
      last_console_access_at: created_at,
      deactivated_at: null,
      created_at,
      updated_at: created_at,
    },
  };
}

export class ProvisioningLimitError extends Error {
  constructor() {
    super("Too many server creations from this IP address. Please try again in a minute.");
  }
}

export function workspace_ip_hash(client_address: string): string {
  const address = client_address.trim();
  const version = isIP(address);
  if (!version) throw new Error("A valid client IP address is required for workspace creation.");
  let normalized = address;
  if (version === 6) {
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      const low = parseInt(mapped[2]!, 16);
      normalized = [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
    }
  }
  return hash_secret(`workspace-ip:v1\0${normalized}`);
}

async function check_allocation_quota(transaction: Pick<Database, "select" | "execute">, ip_hash: string) {
  // Separate IPs do not contend for a global allocation lock. The database
  // shares each rolling-minute quota across all application processes.
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('scim-lab:anonymous-ip'), hashtext(${ip_hash}))`);
  const [{ value }] = await transaction
    .select({ value: count() })
    .from(anonymous_bootstraps)
    .where(
      and(
        eq(anonymous_bootstraps.allocation_ip_hash, ip_hash),
        gt(anonymous_bootstraps.created_at, new Date(Date.now() - 60_000)),
      ),
    );
  if (Number(value) >= APP_CONFIG.workspace_creations_per_minute) throw new ProvisioningLimitError();
}

export async function materialize_workspace(workspace: AnonymousWorkspace, database: Database, client_address: string) {
  const ip_hash = workspace_ip_hash(client_address);
  if (!recently_issued(workspace.created_at, Date.now(), 37)) throw new Error("This temporary workspace has expired.");
  return database.transaction(async (transaction) => {
    // Serialize first activation across processes and concurrent SCIM/browser requests.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('scim-lab:anonymous-workspace'), hashtext(${workspace.server_id}))`,
    );
    const [existing] = await transaction
      .select()
      .from(scim_servers)
      .where(eq(scim_servers.id, workspace.server_id))
      .limit(1);
    if (existing) return existing;
    const [consumed] = await transaction
      .select()
      .from(anonymous_bootstraps)
      .where(eq(anonymous_bootstraps.server_id, workspace.server_id))
      .limit(1);
    if (consumed) throw new Error("This temporary workspace is no longer available.");
    await check_allocation_quota(transaction, ip_hash);
    const { user, server } = provisional_records(workspace);
    await transaction.insert(anonymous_bootstraps).values({
      server_id: server.id,
      user_id: user.id,
      allocation_ip_hash: ip_hash,
      expires_at: new Date(workspace.created_at + 37 * DAY_MS),
    });
    await transaction.insert(console_users).values(user);
    const [created] = await transaction
      .insert(scim_servers)
      .values({
        ...server,
        bearer_token_encrypted: encrypt_secret(workspace.bearer_token),
      })
      .returning();
    await transaction.insert(server_members).values({ server_id: server.id, user_id: user.id });
    return created!;
  });
}

export async function revoke_anonymous_cookie(
  workspace: AnonymousWorkspace,
  database: Database,
  client_address: string,
) {
  const ip_hash = workspace_ip_hash(client_address);
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('scim-lab:anonymous-workspace'), hashtext(${workspace.server_id}))`,
    );
    const [existing] = await transaction
      .select()
      .from(anonymous_bootstraps)
      .where(eq(anonymous_bootstraps.server_id, workspace.server_id))
      .limit(1);
    if (existing?.revoked_at) return;
    // Even discarding an unused workspace must not bypass the storage quota by
    // creating unbounded revocation markers through repeated bootstrap/logout.
    if (!existing) await check_allocation_quota(transaction, ip_hash);
    await transaction
      .insert(anonymous_bootstraps)
      .values({
        server_id: workspace.server_id,
        user_id: workspace.user_id,
        allocation_ip_hash: ip_hash,
        expires_at: new Date(Date.now() + 37 * DAY_MS),
        revoked_at: new Date(),
      })
      .onConflictDoUpdate({
        target: anonymous_bootstraps.server_id,
        set: {
          revoked_at: new Date(),
          expires_at: new Date(Date.now() + 37 * DAY_MS),
        },
      });
  });
}

export async function find_anonymous_workspace(workspace: AnonymousWorkspace, database: Database) {
  const [marker] = await database
    .select()
    .from(anonymous_bootstraps)
    .where(eq(anonymous_bootstraps.server_id, workspace.server_id))
    .limit(1);
  if (marker?.revoked_at) return null;
  const [row] = await database
    .select({ server: scim_servers, user: console_users })
    .from(scim_servers)
    .innerJoin(console_users, eq(console_users.id, scim_servers.created_by_user_id))
    .where(and(eq(scim_servers.id, workspace.server_id), eq(console_users.id, workspace.user_id)))
    .limit(1);
  if (row) {
    if (!row.user.is_anonymous) return null;
    // Stateless sessions have no session row to protect a recently active owner
    // after server deletion. Keep a throttled activity timestamp on that user.
    if (row.user.updated_at.getTime() < Date.now() - TOUCH_INTERVAL_MS) {
      await database
        .update(console_users)
        .set({ updated_at: new Date() })
        .where(
          and(
            eq(console_users.id, row.user.id),
            lt(console_users.updated_at, new Date(Date.now() - TOUCH_INTERVAL_MS)),
          ),
        );
    }
    return { user: row.user };
  }
  if (marker || !recently_issued(workspace.created_at, Date.now(), 37)) return null;
  const records = provisional_records(workspace);
  return { user: records.user, fresh_server: records.server, provisional: workspace };
}
