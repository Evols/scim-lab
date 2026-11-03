import { sql } from "drizzle-orm";
import { maintenance_queries } from "../../../scripts/maintenance-queries.mjs";
import type { Database } from "../database.ts";

// Requests never run global maintenance. Tests exercise the worker's exact SQL.
export async function purge_expired_records(database: Database, batch_size = 100): Promise<Record<string, number>> {
  if (!Number.isSafeInteger(batch_size) || batch_size < 1 || batch_size > 10000)
    throw new Error("Invalid maintenance batch size.");
  const counts: Record<string, number> = {};
  for (const query of maintenance_queries) {
    const rows = await database.execute(
      sql.raw(query.remove.replaceAll("$1", String(batch_size)).replaceAll("$2", "NULL")),
    );
    counts[query.name] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}
