import { describe, expect, it } from "vitest";
import {
  anonymous_cookie,
  create_provisional_workspace,
  DAY_MS,
  provisional_records,
  read_anonymous_cookie,
  read_bootstrap_bearer,
  workspace_ip_hash,
} from "./anonymous";
import { find_console_context, get_console_context, type CookieStore } from "./context";
import type { Database } from "../database";
import { encrypt_secret } from "../crypto";

describe("provisional anonymous workspaces", () => {
  const now = Date.now();
  it("normalizes IPv4, mapped IPv4, and equivalent IPv6 addresses for quotas", () => {
    expect(workspace_ip_hash("192.0.2.1")).toBe(workspace_ip_hash("::ffff:192.0.2.1"));
    expect(workspace_ip_hash("192.0.2.1")).toBe(workspace_ip_hash("::ffff:c000:201"));
    expect(workspace_ip_hash("2001:db8::1")).toBe(workspace_ip_hash("2001:0DB8:0000:0000:0000:0000:0000:0001"));
    expect(workspace_ip_hash("192.0.2.1")).not.toBe(workspace_ip_hash("192.0.2.2"));
    for (const invalid of ["", "unknown", "192.0.2.1, 192.0.2.2"])
      expect(() => workspace_ip_hash(invalid)).toThrow("valid client IP");
  });

  it("issues stable endpoint credentials without storing any database rows", async () => {
    const values = new Map<string, string>();
    const cookies: CookieStore = {
      get: (name) => (values.has(name) ? { value: values.get(name)! } : undefined),
      set: (name, value) => {
        values.set(name, value);
      },
      delete: (name) => {
        values.delete(name);
      },
    };
    const database = new Proxy(
      {},
      {
        get() {
          throw new Error("Unexpected database access");
        },
      },
    ) as Database;
    expect(await find_console_context(cookies, database)).toBeNull();
    const context = await get_console_context(cookies, database);
    expect(context.provisional).toBeDefined();
    expect(context.fresh_server!.id).toBe(context.provisional!.server_id);
    expect(read_anonymous_cookie(context.session_token!)?.bearer_token).toBe(context.provisional!.bearer_token);
  });

  it("binds bootstrap bearer credentials to their server and rejects tampering", () => {
    const workspace = create_provisional_workspace(now);
    expect(read_bootstrap_bearer(workspace.bearer_token, workspace.server_id, now)).toEqual(workspace);
    expect(read_bootstrap_bearer(workspace.bearer_token, crypto.randomUUID(), now)).toBeNull();
    expect(read_bootstrap_bearer(workspace.bearer_token + "x", workspace.server_id, now)).toBeNull();
    const truncated_tag = workspace.bearer_token.split(".");
    truncated_tag[3] = Buffer.from(truncated_tag[3]!, "base64url").subarray(0, 4).toString("base64url");
    expect(read_bootstrap_bearer(truncated_tag.join("."), workspace.server_id, now)).toBeNull();
    expect(read_anonymous_cookie(anonymous_cookie(workspace, now) + "x", now)).toBeNull();
    expect(provisional_records(workspace).server.bearer_token_hash).toBeTruthy();
  });

  it("separates console ownership from SCIM credentials", () => {
    const workspace = create_provisional_workspace(now);
    const cookie = anonymous_cookie(workspace, now);
    expect(read_anonymous_cookie(workspace.bearer_token, now)).toBeNull();
    expect(
      read_anonymous_cookie("anon_v1." + workspace.bearer_token.slice("scim_bootstrap_v1.".length), now),
    ).toBeNull();
    expect(
      read_bootstrap_bearer("scim_bootstrap_v1." + cookie.slice("anon_v1.".length), workspace.server_id, now),
    ).toBeNull();
  });

  it("expires unused SCIM credentials at seven days and ownership cookies at 14 days", () => {
    const workspace = create_provisional_workspace(now);
    const cookie = anonymous_cookie(workspace, now);
    expect(read_bootstrap_bearer(workspace.bearer_token, workspace.server_id, now + 7 * DAY_MS - 1)).not.toBeNull();
    expect(read_bootstrap_bearer(workspace.bearer_token, workspace.server_id, now + 7 * DAY_MS)).toBeNull();
    expect(read_anonymous_cookie(cookie, now + 14 * DAY_MS - 1)).not.toBeNull();
    expect(read_anonymous_cookie(cookie, now + 14 * DAY_MS)).toBeNull();
    const renewed = anonymous_cookie(workspace, now + 13 * DAY_MS);
    expect(read_anonymous_cookie(renewed, now + 26 * DAY_MS)).not.toBeNull();
    expect(read_anonymous_cookie(renewed, now + 27 * DAY_MS)).toBeNull();
  });

  it("applies the 14-day idle window to legacy 37-day cookies", () => {
    const workspace = create_provisional_workspace(now - 60 * DAY_MS);
    const { bearer_token, ...metadata } = workspace;
    const cookie =
      "anon_v1." +
      encrypt_secret(
        JSON.stringify({
          purpose: "anonymous-console-v1",
          workspace: metadata,
          bearer_token,
          expires_at: now + 37 * DAY_MS,
        }),
      );
    expect(read_anonymous_cookie(cookie, now + 14 * DAY_MS - 1)).toEqual(workspace);
    expect(read_anonymous_cookie(cookie, now + 14 * DAY_MS)).toBeNull();
  });
});
