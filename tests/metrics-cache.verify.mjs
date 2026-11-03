// Run after infra/metrics/setup.sql and verify.sql on an isolated test database.
// Locks source tables briefly to prove panel reads never touch the large tables.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL || !process.env.GRAFANA_DATABASE_PASSWORD) {
  throw new Error("DATABASE_URL and GRAFANA_DATABASE_PASSWORD are required for the metrics cache check.");
}
const metrics_url = new URL(process.env.DATABASE_URL);
metrics_url.username = "grafana_metrics";
metrics_url.password = process.env.GRAFANA_DATABASE_PASSWORD;
const owner = postgres(process.env.DATABASE_URL, { max: 1 });
const other_owner = postgres(process.env.DATABASE_URL, { max: 1 });
const reader = postgres(metrics_url.href, { max: 1 });
const dashboard = JSON.parse(
  await readFile(new URL("../infra/grafana/dashboards/scim-lab.json", import.meta.url), "utf8"),
);
const panel_queries = dashboard.panels.flatMap((panel) =>
  panel.targets.map((target) =>
    target.rawSql
      .replaceAll("$__timeFrom()", "'2026-01-01T12:00:00Z'")
      .replaceAll("$__timeTo()", "'2026-01-31T12:00:00Z'"),
  ),
);

async function read_panels() {
  return reader.begin("read only", async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '1s'`;
    await transaction`SET LOCAL lock_timeout = '250ms'`;
    const result = [];
    for (const query of panel_queries) {
      const rows = await transaction.unsafe(query);
      assert(rows.length > 0, "A populated cache must return data for every panel, including zero-filled days.");
      result.push(JSON.parse(JSON.stringify(rows)));
    }
    return result;
  });
}

try {
  const baseline = await read_panels();
  await owner.begin(async (transaction) => {
    await transaction.unsafe(`LOCK TABLE public.console_users, public.console_sessions,
      public.scim_servers, public.scim_users, public.scim_groups IN ACCESS EXCLUSIVE MODE`);
    assert.deepEqual(
      await read_panels(),
      baseline,
      "All dashboard panels must read cached data even when source tables are locked.",
    );
  });

  const body = await readFile(new URL("../infra/metrics/refresh-data.sql", import.meta.url), "utf8");
  await assert.rejects(
    owner.begin(async (transaction) => {
      await transaction.unsafe(body).simple();
      assert.deepEqual(
        await read_panels(),
        baseline,
        "Readers must keep seeing the committed snapshot during refresh.",
      );
      throw new Error("Simulated metrics refresh failure");
    }),
    /Simulated metrics refresh failure/,
  );
  assert.deepEqual(
    await read_panels(),
    baseline,
    "A failed refresh must preserve every cached result and its timestamp.",
  );

  await owner.begin(async (transaction) => {
    await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('scim-lab:metrics-refresh', 0))");
    await other_owner.begin(async (other) => {
      const [row] = await other.unsafe(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('scim-lab:metrics-refresh', 0)) AS acquired",
      );
      assert.equal(row.acquired, false, "A second refresh must skip instead of repeating expensive scans.");
    });
  });
  console.log(
    "Metrics cache checks passed: fast reads with locked source tables, nonblocking refresh, rollback preservation, and refresh serialization.",
  );
} finally {
  await Promise.all([owner.end(), other_owner.end(), reader.end()]);
}
