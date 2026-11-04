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
  if (Object.keys(result.errors ?? {}).length) return options.interval_seconds;
  return result.backlog ? options.catch_up_seconds : options.interval_seconds;
}

export async function run_maintenance(client, options, cursors = {}, signal, report = (_event) => {}) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Record<string, number>} */
  const scanned = {};
  /** @type {Record<string, {code: string, message?: string, batch_size: number, cursor: string | null}>} */
  const errors = {};
  const batch_sizes = {};
  const pending = new Set(maintenance_queries);
  for (const query of maintenance_queries) counts[query.name] = 0;
  // Alternate tables so a session/event backlog cannot monopolize an entire
  // cycle. Server batches still precede account batches for cascading cleanup.
  rounds: for (let batch = 0; batch < (options.apply ? options.max_batches : 1); batch++) {
    for (const query of pending) {
      if (signal?.aborted) break rounds;
      let result;
      let batch_size = batch_sizes[query.name] ?? options.batch_size;
      while (true) {
        if (signal?.aborted) break rounds;
        report({ event: "batch_started", table: query.name, batch_size, cursor: cursors[query.name] ?? null });
        try {
          result = await client.begin(options.apply ? "" : "read only", async (transaction) => {
            await transaction`SET LOCAL statement_timeout = '30s'`;
            await transaction`SET LOCAL lock_timeout = '2s'`;
            const parameters = [batch_size, cursors[query.name] ?? null];
            const [result] = await transaction.unsafe(options.apply ? query.remove : query.preview, parameters);
            return result;
          });
          break;
        } catch (error) {
          if (error.code === "57014" && batch_size > 1 && !signal?.aborted) {
            batch_size = Math.max(1, Math.floor(batch_size / 2));
            batch_sizes[query.name] = batch_size;
            report({
              event: "batch_retry",
              table: query.name,
              code: error.code,
              message: error.message,
              batch_size,
              cursor: cursors[query.name] ?? null,
            });
            continue;
          }
          errors[query.name] = {
            code: error.code ?? error.name ?? "Error",
            message: error.message,
            batch_size,
            cursor: cursors[query.name] ?? null,
          };
          report({ event: "table_error", table: query.name, ...errors[query.name] });
          pending.delete(query);
          break;
        }
      }
      if (!result) continue;
      const count = Number(result.count);
      counts[query.name] += count;
      const scanned_count = Number(result.scanned ?? count);
      if (query.scan) {
        scanned[query.name] = (scanned[query.name] ?? 0) + scanned_count;
        cursors[query.name] = scanned_count < batch_size ? null : result.cursor;
      }
      report({
        event: "batch_completed",
        table: query.name,
        batch_size,
        count,
        scanned: scanned_count,
        total: counts[query.name],
      });
      if (scanned_count < batch_size) pending.delete(query);
    }
    if (!pending.size) break;
  }
  return {
    mode: options.apply ? "deleted" : "eligible_in_scanned_batch",
    counts,
    scanned,
    errors,
    backlog: pending.size > 0 || Object.keys(errors).length > 0,
  };
}

async function main() {
  const options = parse_options(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL explicitly before running maintenance.");
  const client = postgres(process.env.DATABASE_URL, {
    max: 1,
    connection: { application_name: "scim-lab-maintenance" },
  });
  const cursors = {};
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    do {
      let delay_seconds = options.interval_seconds;
      try {
        let last_progress_at = 0;
        const result = await run_maintenance(client, options, cursors, abort.signal, (event) => {
          if (!["batch_started", "batch_completed"].includes(event.event) || Date.now() - last_progress_at >= 5000) {
            console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
            last_progress_at = Date.now();
          }
        });
        delay_seconds = maintenance_delay_seconds(result, options);
        console.log(JSON.stringify({ time: new Date().toISOString(), ...result }));
        if (!options.watch && Object.keys(result.errors).length) process.exitCode = 1;
      } catch (error) {
        console.error(
          JSON.stringify({ maintenance_error: error.code ?? error.name ?? "Error", message: error.message }),
        );
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
