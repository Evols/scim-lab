import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { parse_options, run_maintenance } from "../scripts/maintenance.mjs";
import { console_users, scim_servers, server_members } from "../src/db/schema";
import { APP_CONFIG } from "../src/lib/config";
import { db } from "../src/lib/database";

describe("standalone scheduled cleanup", () => {
  it("previews without deleting and scans past retained rows to remove expired workspaces", async () => {
    // Low, ordered fixture UUIDs ensure the first batch must retain a registered
    // owner before later batches reach the two expired anonymous workspaces.
    const ids = [1, 2, 3].map((value) => `00000000-0000-4000-8000-00000000000${value}`);
    const old = new Date(Date.now() - 200 * 86_400_000);
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
