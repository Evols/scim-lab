import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  anonymous_bootstraps,
  console_sessions,
  console_users,
  scim_events,
  scim_servers,
  server_members,
} from "../../db/schema";
import { db } from "../database";
import { with_rollback_transaction } from "../database.testing";
import { rotate_server_auth } from "../management/credential";
import { complete_oidc_login } from "./authentication";
import { handle_scim_request } from "../scim/api/router";
import {
  anonymous_cookie,
  create_provisional_workspace,
  DAY_MS,
  find_anonymous_workspace,
  materialize_workspace,
  ProvisioningLimitError,
  revoke_anonymous_cookie,
  workspace_ip_hash,
  type AnonymousWorkspace,
} from "./anonymous";
import { APP_CONFIG } from "../config";

describe("deferred workspace activation", { sequential: true }, () => {
  const workspaces: AnonymousWorkspace[] = [];
  function workspace(created_at = Date.now()) {
    const value = create_provisional_workspace(created_at);
    workspaces.push(value);
    return value;
  }
  function client_ip(value: AnonymousWorkspace) {
    return `198.51.100.${workspaces.indexOf(value) + 1}`;
  }
  function discovery(value: AnonymousWorkspace, token = value.bearer_token) {
    return handle_scim_request(
      new Request(`https://example.test/scim/${value.server_id}/v2/ServiceProviderConfig`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      value.server_id,
      "ServiceProviderConfig",
      client_ip(value),
    );
  }
  afterAll(async () => {
    if (!workspaces.length) return;
    await db.delete(scim_servers).where(
      inArray(
        scim_servers.id,
        workspaces.map((value) => value.server_id),
      ),
    );
    await db.delete(console_users).where(
      inArray(
        console_users.id,
        workspaces.map((value) => value.user_id),
      ),
    );
    await db.delete(anonymous_bootstraps).where(
      inArray(
        anonymous_bootstraps.server_id,
        workspaces.map((value) => value.server_id),
      ),
    );
  });

  it("browses without rows, activates on the first authenticated discovery, and keeps credentials stable", async () => {
    const value = workspace();
    expect((await find_anonymous_workspace(value, db))?.provisional).toEqual(value);
    expect(await db.select().from(console_users).where(eq(console_users.id, value.user_id))).toHaveLength(0);
    expect(await db.select().from(scim_servers).where(eq(scim_servers.id, value.server_id))).toHaveLength(0);
    expect((await discovery(value)).status).toBe(200);
    expect(await db.select().from(server_members).where(eq(server_members.server_id, value.server_id))).toHaveLength(1);
    expect(await db.select().from(scim_events).where(eq(scim_events.server_id, value.server_id))).toHaveLength(1);
    expect(await db.select().from(console_sessions).where(eq(console_sessions.user_id, value.user_id))).toHaveLength(0);
    expect((await find_anonymous_workspace(value, db))?.provisional).toBeUndefined();
    expect((await discovery(value)).status).toBe(200);
  });

  it("does not allocate for invalid, expired, wrong-server, or console-cookie credentials", async () => {
    const value = workspace();
    const expired = workspace(Date.now() - 8 * DAY_MS);
    expect((await discovery(value, value.bearer_token + "x")).status).toBe(404);
    expect((await discovery(value, expired.bearer_token)).status).toBe(404);
    expect((await discovery(expired)).status).toBe(404);
    expect((await discovery(value, anonymous_cookie(value))).status).toBe(404);
    expect(await db.select().from(console_users).where(eq(console_users.id, value.user_id))).toHaveLength(0);
  });

  it("materializes only once under concurrent activation", async () => {
    const value = workspace();
    await Promise.all([
      materialize_workspace(value, db, client_ip(value)),
      materialize_workspace(value, db, "192.0.2.200"),
    ]);
    expect(await db.select().from(scim_servers).where(eq(scim_servers.id, value.server_id))).toHaveLength(1);
    expect(await db.select().from(server_members).where(eq(server_members.server_id, value.server_id))).toHaveLength(1);
  });

  it("never restores a rotated credential or recreates a deleted workspace", async () => {
    const value = workspace();
    await materialize_workspace(value, db, client_ip(value));
    await rotate_server_auth(value.user_id, value.server_id, "bearer", db);
    expect((await discovery(value)).status).toBe(401);
    await db.delete(scim_servers).where(eq(scim_servers.id, value.server_id));
    expect((await discovery(value)).status).toBe(404);
    expect(await find_anonymous_workspace(value, db)).toBeNull();
    await expect(materialize_workspace(value, db, client_ip(value))).rejects.toThrow("no longer available");
  });

  it("revokes old anonymous console cookies at logout and account upgrade", async () => {
    const logged_out = workspace();
    await materialize_workspace(logged_out, db, client_ip(logged_out));
    await revoke_anonymous_cookie(logged_out, db, client_ip(logged_out));
    expect(await find_anonymous_workspace(logged_out, db)).toBeNull();
    expect((await discovery(logged_out)).status).toBe(200);
    const upgraded = workspace();
    await materialize_workspace(upgraded, db, client_ip(upgraded));
    await complete_oidc_login(upgraded.user_id, { issuer: "https://identity.test", subject: upgraded.user_id }, db);
    expect(await find_anonymous_workspace(upgraded, db)).toBeNull();
  });

  it(
    "limits each IP independently across processes without partially creating a user",
    with_rollback_transaction(async (transaction) => {
      const markers = Array.from({ length: APP_CONFIG.workspace_creations_per_minute }, () => ({
        server_id: crypto.randomUUID(),
        user_id: crypto.randomUUID(),
        allocation_ip_hash: workspace_ip_hash("203.0.113.1"),
        expires_at: new Date(Date.now() + DAY_MS),
      }));
      await transaction.insert(anonymous_bootstraps).values(markers);
      const value = create_provisional_workspace();
      await expect(materialize_workspace(value, transaction, "203.0.113.1")).rejects.toBeInstanceOf(
        ProvisioningLimitError,
      );
      await expect(revoke_anonymous_cookie(value, transaction, "203.0.113.1")).rejects.toBeInstanceOf(
        ProvisioningLimitError,
      );
      expect(await transaction.select().from(console_users).where(eq(console_users.id, value.user_id))).toHaveLength(0);
      await materialize_workspace(value, transaction, "203.0.113.2");
      // Existing workspaces do not consume another slot, even from a full IP.
      await materialize_workspace(value, transaction, "203.0.113.1");
      const [marker] = await transaction
        .select()
        .from(anonymous_bootstraps)
        .where(eq(anonymous_bootstraps.server_id, value.server_id));
      expect(marker!.allocation_ip_hash).toBe(workspace_ip_hash("203.0.113.2"));
    }),
  );

  it("allows only two concurrent creations per IP and returns 429 for a third activation", async () => {
    const attempts = Array.from({ length: APP_CONFIG.workspace_creations_per_minute + 1 }, () => workspace());
    const results = await Promise.allSettled(attempts.map((value) => materialize_workspace(value, db, "203.0.113.3")));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      APP_CONFIG.workspace_creations_per_minute,
    );
    const rejected = results.findIndex(({ status }) => status === "rejected");
    expect((results[rejected] as PromiseRejectedResult).reason).toBeInstanceOf(ProvisioningLimitError);
    const value = attempts[rejected]!;
    const request = new Request(`https://example.test/scim/${value.server_id}/v2/ServiceProviderConfig`, {
      headers: { authorization: `Bearer ${value.bearer_token}` },
    });
    const response = await handle_scim_request(request, value.server_id, "ServiceProviderConfig", "203.0.113.3");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await db.select().from(console_users).where(eq(console_users.id, value.user_id))).toHaveLength(0);
    expect((await handle_scim_request(request, value.server_id, "ServiceProviderConfig", "203.0.113.4")).status).toBe(
      200,
    );
  });

  it(
    "releases slots after the rolling minute expires",
    with_rollback_transaction(async (transaction) => {
      await transaction.insert(anonymous_bootstraps).values(
        Array.from({ length: APP_CONFIG.workspace_creations_per_minute }, () => ({
          server_id: crypto.randomUUID(),
          user_id: crypto.randomUUID(),
          allocation_ip_hash: workspace_ip_hash("203.0.113.5"),
          created_at: new Date(Date.now() - 61_000),
          expires_at: new Date(Date.now() + DAY_MS),
        })),
      );
      const value = create_provisional_workspace();
      await materialize_workspace(value, transaction, "203.0.113.5");
      expect(await transaction.select().from(scim_servers).where(eq(scim_servers.id, value.server_id))).toHaveLength(1);
    }),
  );
});
