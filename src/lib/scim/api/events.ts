import { prune_events } from "../../management/console";
import { db } from "../../database";
import { scim_events } from "../../../db/schema.ts";

type DynamicObject = Record<string, unknown>;

function sanitized_headers(headers: Headers): Record<string, string> {
  const sensitive = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
  return Object.fromEntries(
    [...headers.entries()].map(([name, value]) => [name, sensitive.has(name.toLowerCase()) ? "[REDACTED]" : value]),
  );
}

function redact_body(value: string): string {
  if (!value) {
    return value;
  }
  try {
    const visit = (input: unknown): unknown => {
      if (Array.isArray(input)) {
        return input.map(visit);
      }
      if (!input || typeof input !== "object") {
        return input;
      }
      return Object.fromEntries(
        Object.entries(input as DynamicObject).map(([key, entry]) => [
          key,
          /(password|token|secret|authorization)/i.test(key) ? "[REDACTED]" : visit(entry),
        ]),
      );
    };
    return JSON.stringify(visit(JSON.parse(value)));
  } catch {
    // Non-JSON bodies are retained for diagnostics; headers are still redacted.
    return value;
  }
}

export async function record_event(
  server_id: string,
  request: Request,
  response: Response,
  request_body: string,
  started_at: number,
  auth_mode: string | null,
  auth_success: boolean,
): Promise<void> {
  // `request_body` is the raw body captured before Zod parsing. Redaction only
  // replaces sensitive values; it does not select or discard object fields.
  const request_value = redact_body(request_body);
  const response_value = response.status === 204 ? "" : await response.clone().text();
  const request_url = new URL(request.url);
  await db.insert(scim_events).values({
    server_id,
    method: request.method,
    path: `${request_url.pathname}${request_url.search}`,
    status: response.status,
    duration_ms: Math.max(0, Date.now() - started_at),
    auth_mode,
    auth_success,
    request_headers: sanitized_headers(request.headers),
    request_body: request_value || null,
    response_body: response_value || null,
    request_truncated: false,
    response_truncated: false,
  });
  await prune_events(server_id, db);
}
