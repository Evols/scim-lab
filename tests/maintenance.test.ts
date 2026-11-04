import { describe, expect, it } from "vitest";
import { maintenance_delay_seconds, parse_options, run_maintenance } from "../scripts/maintenance.mjs";

describe("maintenance command", () => {
  it("defaults to a bounded, read-only preview and requires explicit apply for the worker", () => {
    expect(parse_options([])).toMatchObject({ apply: false, watch: false, batch_size: 500, max_batches: 100 });
    expect(parse_options(["--max-batches=100000"]).max_batches).toBe(100000);
    expect(parse_options(["--apply", "--watch", "--batch-size=250", "--max-batches=20"])).toMatchObject({
      apply: true,
      watch: true,
      batch_size: 250,
      max_batches: 20,
    });
    for (const args of [
      ["--watch"],
      ["--batch-size=0"],
      ["--batch-size=10001"],
      ["--max-batches=oops"],
      ["--catch-up-seconds=0"],
      ["--aply"],
    ]) {
      expect(() => parse_options(args)).toThrow();
    }
  });

  it("continues parent-table scans across empty batches and carries cursors across cycles", async () => {
    const cursors: Record<string, string | null> = {};
    const recorded: unknown[][] = [];
    const client = {
      begin: async (_mode: string, work: (transaction: unknown) => unknown) => {
        const transaction = Object.assign(async () => [], {
          unsafe: async (query: string, parameters: unknown[]) => {
            if (!query.includes("scanned AS MATERIALIZED")) return [{ count: 0 }];
            recorded.push(parameters);
            return [{ count: 0, scanned: 100, cursor: "00000000-0000-4000-8000-000000000001" }];
          },
        });
        return work(transaction);
      },
    };
    const options = parse_options(["--apply", "--batch-size=100", "--max-batches=2"]);
    const result = await run_maintenance(client, options, cursors);
    expect(result.backlog).toBe(true);
    expect(recorded).toHaveLength(16);
    expect(recorded[8]![1]).toBe("00000000-0000-4000-8000-000000000001");
    expect(cursors.scim_servers).toBeTruthy();
    expect(cursors.console_users).toBeTruthy();
    expect(cursors.anonymous_bootstraps).toBeTruthy();
    recorded.length = 0;
    await run_maintenance(client, options, cursors);
    expect(recorded[0]![1]).toBe(cursors.console_sessions);
  });

  it("uses short catch-up pauses until every table scan is exhausted", async () => {
    let full = true;
    const client = {
      begin: async (_mode: string, work: (transaction: unknown) => unknown) => {
        const transaction = Object.assign(async () => [], {
          unsafe: async (query: string) =>
            query.includes("scanned AS MATERIALIZED")
              ? [{ count: 0, scanned: full ? 500 : 0, cursor: full ? "00000000-0000-4000-8000-000000000001" : null }]
              : [{ count: 0 }],
        });
        return work(transaction);
      },
    };
    const options = parse_options(["--apply", "--max-batches=1"]);
    const cursors = {};
    const backlog = await run_maintenance(client, options, cursors);
    expect(maintenance_delay_seconds(backlog, options)).toBe(1);
    full = false;
    const drained = await run_maintenance(client, options, cursors);
    expect(drained.backlog).toBe(false);
    expect(maintenance_delay_seconds(drained, options)).toBe(300);
    expect(Object.values(cursors)).toEqual(Array(8).fill(null));
    expect(maintenance_delay_seconds(backlog, parse_options(["--catch-up-seconds=5"]))).toBe(5);
  });

  it("stops between batches when shutdown is requested", async () => {
    const abort = new AbortController();
    let transactions = 0;
    const client = {
      begin: async (_mode: string, work: (transaction: unknown) => unknown) => {
        transactions++;
        const transaction = Object.assign(async () => [], {
          unsafe: async () => {
            abort.abort();
            return [{ count: 500 }];
          },
        });
        return work(transaction);
      },
    };
    const result = await run_maintenance(client, parse_options(["--apply"]), {}, abort.signal);
    expect(transactions).toBe(1);
    expect(result.counts.console_sessions).toBe(500);
    expect(result.counts.scim_servers).toBe(0);
  });

  it("retries timed-out batches at the same cursor with fewer rows", async () => {
    const attempts: unknown[][] = [];
    const events: { event: string; table: string; batch_size: number }[] = [];
    const cursors = { console_sessions: "previous-token" };
    const client = {
      begin: async (_mode: string, work: (transaction: unknown) => unknown) => {
        const transaction = Object.assign(async () => [], {
          unsafe: async (query: string, parameters: unknown[]) => {
            if (!query.includes("FROM public.console_sessions")) return [{ count: 0, scanned: 0, cursor: null }];
            attempts.push([...parameters]);
            if (Number(parameters[0]) > 125) throw Object.assign(new Error("statement timeout"), { code: "57014" });
            return [{ count: 2, scanned: 3, cursor: "next-token" }];
          },
        });
        return work(transaction);
      },
    };
    const result = await run_maintenance(client, parse_options(["--apply"]), cursors, undefined, (event) =>
      events.push(event),
    );
    expect(attempts).toEqual([
      [500, "previous-token"],
      [250, "previous-token"],
      [125, "previous-token"],
    ]);
    expect(result.counts.console_sessions).toBe(2);
    expect(result.errors).toEqual({});
    expect(events.filter((event) => event.event === "batch_retry").map((event) => event.batch_size)).toEqual([
      250, 125,
    ]);
  });

  it("reports a failing table, retains its cursor, and still cleans other tables", async () => {
    const cursors = { console_sessions: "previous-token" };
    const client = {
      begin: async (_mode: string, work: (transaction: unknown) => unknown) => {
        const transaction = Object.assign(async () => [], {
          unsafe: async (query: string) => {
            if (query.includes("FROM public.console_sessions"))
              throw Object.assign(new Error("statement timeout"), { code: "57014" });
            return [{ count: 1, scanned: 1, cursor: "next" }];
          },
        });
        return work(transaction);
      },
    };
    const options = parse_options(["--apply", "--batch-size=1", "--max-batches=1"]);
    const result = await run_maintenance(client, options, cursors);
    expect(result.errors.console_sessions).toMatchObject({
      code: "57014",
      message: "statement timeout",
      batch_size: 1,
      cursor: "previous-token",
    });
    expect(cursors.console_sessions).toBe("previous-token");
    expect(result.counts.scim_servers).toBe(1);
    expect(result.counts.console_users).toBe(1);
    expect(maintenance_delay_seconds(result, options)).toBe(300);
  });
});
