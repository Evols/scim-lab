import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { parse_options, run_maintenance } from "../scripts/maintenance.mjs";
import { console_users, scim_servers, server_members } from "../src/db/schema";
import { APP_CONFIG } from "../src/lib/config";
import { db } from "../src/lib/database";

describe("standalone scheduled cleanup", () => {
  it("drains more than the old hourly limit in one cycle while preserving live workspaces", async () => {
    const ids = Array.from(
      { length: 1205 },
      (_, index) => `00000000-0000-4001-8000-${index.toString(16).padStart(12, "0")}`,
    );
    const now = new Date();
    const old = new Date(Date.now() - 15 * 86_400_000);
    const client = postgres(APP_CONFIG.database_url, { max: 1 });
    const rollback = new Error("rollback backlog fixture");
    try {
      // Keep the large fixture invisible to parallel tests with bounded scans.
      await client.begin(async (transaction) => {
        const users = ids.map((id, index) => ({
          id,
          is_anonymous: index !== 0,
          created_at: old,
          updated_at: index === 1 ? now : old,
        }));
        await transaction`INSERT INTO console_users ${transaction(users)}`;
        const servers = ids.map((id, index) => ({
          id,
          name: "backlog fixture",
          created_by_user_id: id,
          last_console_access_at: index < 2 ? now : old,
        }));
        await transaction`INSERT INTO scim_servers ${transaction(servers)}`;
        await transaction`INSERT INTO server_members ${transaction(ids.map((id) => ({ user_id: id, server_id: id })))}`;
        const markers = ids.map((id, index) => ({
          server_id: id,
          user_id: id,
          created_at: index < 2 ? now : old,
          expires_at: new Date(Date.now() + 37 * 86_400_000),
        }));
        await transaction`INSERT INTO anonymous_bootstraps ${transaction(markers)}`;
        const result = await run_maintenance(
          {
            begin: (_mode: string, work: (sql: postgres.TransactionSql) => Promise<unknown>) =>
              transaction.savepoint(work),
          },
          parse_options(["--apply"]),
        );
        expect(result.counts.scim_servers).toBeGreaterThanOrEqual(1203);
        expect(result.counts.console_users).toBeGreaterThanOrEqual(1203);
        expect(result.counts.anonymous_bootstraps).toBeGreaterThanOrEqual(1203);
        for (const [table, column] of [
          ["scim_servers", "id"],
          ["console_users", "id"],
          ["anonymous_bootstraps", "server_id"],
          ["server_members", "server_id"],
        ] as const) {
          const [remaining] =
            await transaction`SELECT count(*)::integer AS count FROM ${transaction(table)} WHERE ${transaction(column)} IN ${transaction(ids)}`;
          expect(remaining.count).toBe(2);
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await client.end();
    }
  });

  it("previews without deleting and scans past retained rows to remove expired workspaces", async () => {
    // Low, ordered fixture UUIDs ensure the first batch must retain a registered
    // owner before later batches reach the two expired anonymous workspaces.
    const ids = [1, 2, 3].map((value) => `00000000-0000-4000-8000-00000000000${value}`);
    const old = new Date(Date.now() - 15 * 86_400_000);
    const client = postgres(APP_CONFIG.database_url, { max: 1 });
    try {
      await db
        .insert(console_users)
        .values(ids.map((id, index) => ({ id, is_anonymous: index !== 0, created_at: old, updated_at: old })));
      await db.insert(scim_servers).values(
        ids.map((id, index) => ({
          id,
          name: "maintenance fixture",
          created_by_user_id: id,
          last_console_access_at: index === 0 ? new Date() : new Date(Date.now() - 15 * 86_400_000),
        })),
      );
      await db.insert(server_members).values(ids.map((id) => ({ user_id: id, server_id: id })));
      const preview = await run_maintenance(client, parse_options(["--batch-size=1"]));
      expect(preview.mode).toBe("eligible_in_scanned_batch");
      expect(await db.select().from(scim_servers).where(inArray(scim_servers.id, ids))).toHaveLength(3);
      const applied = await run_maintenance(client, parse_options(["--apply", "--batch-size=1", "--max-batches=10"]));
      expect(applied.counts.scim_servers).toBeGreaterThanOrEqual(2);
      expect((await db.select().from(scim_servers).where(inArray(scim_servers.id, ids))).map(({ id }) => id)).toEqual([
        ids[0],
      ]);
      expect((await db.select().from(console_users).where(inArray(console_users.id, ids))).map(({ id }) => id)).toEqual(
        [ids[0]],
      );
      expect(await db.select().from(server_members).where(eq(server_members.server_id, ids[1]!))).toHaveLength(0);
    } finally {
      await db.delete(scim_servers).where(inArray(scim_servers.id, ids));
      await db.delete(console_users).where(inArray(console_users.id, ids));
      await client.end();
    }
  });
});
