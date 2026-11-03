import { describe, expect, it } from "vitest";
import { parse_options, run_maintenance } from "../scripts/maintenance.mjs";

describe("maintenance command", () => {
  it("defaults to a bounded, read-only preview and requires explicit apply for the worker", () => {
    expect(parse_options([])).toMatchObject({ apply: false, watch: false, batch_size: 100, max_batches: 10 });
    expect(parse_options(["--max-batches=100000"]).max_batches).toBe(100000);
    expect(parse_options(["--apply", "--watch", "--batch-size=250", "--max-batches=20"])).toMatchObject({
      apply: true,
      watch: true,
      batch_size: 250,
      max_batches: 20,
    });
    for (const args of [["--watch"], ["--batch-size=0"], ["--batch-size=10001"], ["--max-batches=oops"], ["--aply"]]) {
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
    const options = parse_options(["--apply", "--max-batches=2"]);
    await run_maintenance(client, options, cursors);
    expect(recorded).toHaveLength(4);
    expect(recorded[1]![1]).toBe("00000000-0000-4000-8000-000000000001");
    expect(cursors.scim_servers).toBeTruthy();
    expect(cursors.console_users).toBeTruthy();
    recorded.length = 0;
    await run_maintenance(client, options, cursors);
    expect(recorded[0]![1]).toBe(cursors.scim_servers);
  });
});
