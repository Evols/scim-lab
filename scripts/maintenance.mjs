import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import postgres from "postgres";
import { maintenance_queries } from "./maintenance-queries.mjs";

export function parse_options(args) {
  const options = {
    apply: false,
    watch: false,
    batch_size: 500,
    max_batches: 100,
    interval_seconds: 300,
    catch_up_seconds: 1,
  };
  for (const arg of args) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--watch") options.watch = true;
    else {
      const match = /^--(batch-size|max-batches|interval-seconds|catch-up-seconds)=(\d+)$/.exec(arg);
      if (!match) throw new Error(`Unknown option: ${arg}`);
      const value = Number(match[2]);
      const maximum = match[1] === "max-batches" ? 1_000_000 : 10000;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid value: ${arg}`);
      options[match[1].replaceAll("-", "_")] = value;
    }
  }
  if (options.watch && !options.apply) throw new Error("--watch requires --apply; omit both for a read-only preview.");
  return options;
}

export function maintenance_delay_seconds(result, options) {
  return result.backlog ? options.catch_up_seconds : options.interval_seconds;
}

export async function run_maintenance(client, options, cursors = {}, signal) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Record<string, number>} */
  const scanned = {};
  const pending = new Set(maintenance_queries);
  for (const query of maintenance_queries) counts[query.name] = 0;
  // Alternate tables so a session/event backlog cannot monopolize an entire
  // cycle. Server batches still precede account batches for cascading cleanup.
  rounds: for (let batch = 0; batch < (options.apply ? options.max_batches : 1); batch++) {
    for (const query of pending) {
      if (signal?.aborted) break rounds;
      const result = await client.begin(options.apply ? "" : "read only", async (transaction) => {
        await transaction`SET LOCAL statement_timeout = '30s'`;
        await transaction`SET LOCAL lock_timeout = '2s'`;
        const parameters = query.scan ? [options.batch_size, cursors[query.name] ?? null] : [options.batch_size];
        const [result] = await transaction.unsafe(options.apply ? query.remove : query.preview, parameters);
        return result;
      });
      const count = Number(result.count);
      counts[query.name] += count;
      const scanned_count = Number(result.scanned ?? count);
      if (query.scan) {
        scanned[query.name] = (scanned[query.name] ?? 0) + scanned_count;
        cursors[query.name] = scanned_count < options.batch_size ? null : result.cursor;
      }
      if (scanned_count < options.batch_size) pending.delete(query);
    }
    if (!pending.size) break;
  }
  return { mode: options.apply ? "deleted" : "eligible_in_scanned_batch", counts, scanned, backlog: pending.size > 0 };
}

async function main() {
  const options = parse_options(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL explicitly before running maintenance.");
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const cursors = {};
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    do {
      let delay_seconds = options.interval_seconds;
      try {
        const result = await run_maintenance(client, options, cursors, abort.signal);
        delay_seconds = maintenance_delay_seconds(result, options);
        console.log(JSON.stringify({ time: new Date().toISOString(), ...result }));
      } catch (error) {
        console.error(JSON.stringify({ maintenance_error: error.code ?? error.name ?? "Error" }));
        if (!options.watch) {
          process.exitCode = 1;
          break;
        }
      }
      if (!options.watch || abort.signal.aborted) break;
      try {
        await setTimeout(delay_seconds * 1000, undefined, { signal: abort.signal });
      } catch {
        break;
      }
    } while (!abort.signal.aborted);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
