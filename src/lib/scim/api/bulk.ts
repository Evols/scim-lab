import type { ScimServerRecord } from "../../../db/schema.ts";
import { BulkRequest, BulkResponse, type BulkOperation, type BulkResponse as BulkResponseBody } from "../schemas.ts";
import { BULK_RESPONSE_SCHEMA_URI } from "../server/constants.ts";
import { validate_json_body } from "./body.ts";
import { scim_error } from "./error.ts";
import { handle_groups } from "./groups.ts";
import { json_response } from "./response.ts";
import { handle_users } from "./users.ts";

const MAX_BULK_OPERATIONS = 100;
export const MAX_BULK_PAYLOAD_SIZE = 1_048_576;

export function bulk_references(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/bulkId:([A-Za-z0-9._~-]+)/g)) found.add(match[1]!);
  } else if (Array.isArray(value)) for (const entry of value) bulk_references(entry, found);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) bulk_references(entry, found);
  return found;
}

export function replace_bulk_references(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string")
    return value.replace(/bulkId:([A-Za-z0-9._~-]+)/g, (match, id: string) => (ids.has(id) ? ids.get(id)! : match));
  if (Array.isArray(value)) return value.map((entry) => replace_bulk_references(entry, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace_bulk_references(entry, ids)]));
  return value;
}

async function execute_operation(
  operation: BulkOperation,
  server: ScimServerRecord,
  origin: string,
  ids: Map<string, string>,
): Promise<BulkResponseBody["Operations"][number]> {
  const path = replace_bulk_references(operation.path, ids) as string;
  const url = new URL(path, `${origin}/scim/${server.id}/v2/`);
  const segments = url.pathname.split("/").filter(Boolean);
  const v2_index = segments.lastIndexOf("v2");
  const resource = segments[v2_index + 1];
  const resource_id = segments[v2_index + 2];
  if (!resource || !["Users", "Groups"].includes(resource) || segments.length > v2_index + 3) {
    const error = scim_error(400, `Unsupported Bulk path: ${operation.path}.`, "invalidPath");
    return { method: operation.method, bulkId: operation.bulkId, status: "400", response: await error.json() };
  }
  if (operation.method === "POST" && (!operation.bulkId || resource_id)) {
    const error = scim_error(
      400,
      "Bulk POST operations require a unique bulkId and a resource collection path.",
      "invalidValue",
    );
    return { method: operation.method, bulkId: operation.bulkId, status: "400", response: await error.json() };
  }
  const headers = new Headers({ "content-type": "application/scim+json" });
  if (operation.version) headers.set("if-match", operation.version);
  const data = replace_bulk_references(operation.data, ids);
  const body = operation.method === "DELETE" ? "" : JSON.stringify(data ?? {});
  const response =
    resource === "Users"
      ? await handle_users(operation.method, resource_id, server, origin, url, body, headers)
      : await handle_groups(operation.method, resource_id, server, origin, url, body, headers);
  const response_body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const location =
    response.headers.get("location") ??
    (resource_id ? `${origin}/scim/${server.id}/v2/${resource}/${resource_id}` : undefined);
  const result: BulkResponseBody["Operations"][number] = {
    method: operation.method,
    ...(operation.bulkId ? { bulkId: operation.bulkId } : {}),
    ...(location ? { location } : {}),
    ...(response.headers.get("etag") ? { version: response.headers.get("etag")! } : {}),
    status: String(response.status),
    ...(!response.ok && response_body ? { response: response_body } : {}),
  };
  if (response.ok && operation.method === "POST" && operation.bulkId && location) {
    ids.set(operation.bulkId, decodeURIComponent(location.split("/").at(-1)!));
  }
  return result;
}

export async function bulk_response(server: ScimServerRecord, origin: string, body: string): Promise<Response> {
  if (Buffer.byteLength(body, "utf8") > MAX_BULK_PAYLOAD_SIZE) {
    return scim_error(413, `Bulk payloads are limited to ${MAX_BULK_PAYLOAD_SIZE} bytes.`, "tooMany");
  }
  const validation = validate_json_body(body, BulkRequest);
  if (!validation.success) return validation.response;
  if (validation.data.Operations.length > MAX_BULK_OPERATIONS) {
    return scim_error(413, `Bulk requests are limited to ${MAX_BULK_OPERATIONS} operations.`, "tooMany");
  }
  const declared_ids = new Set(
    validation.data.Operations.flatMap((operation) => (operation.bulkId ? [operation.bulkId] : [])),
  );
  if (declared_ids.size !== validation.data.Operations.filter((operation) => operation.bulkId).length) {
    return scim_error(400, "Bulk bulkId values must be unique.", "uniqueness");
  }

  const ids = new Map<string, string>();
  const pending = validation.data.Operations.map((operation, index) => ({ operation, index }));
  const completed = new Map<number, BulkResponseBody["Operations"][number]>();
  let errors = 0;
  while (pending.length) {
    const ready_index = pending.findIndex(({ operation }) =>
      [...bulk_references([operation.path, operation.data])].every((id) => ids.has(id) || !declared_ids.has(id)),
    );
    if (ready_index < 0) {
      for (const { operation, index } of pending) {
        const error = scim_error(409, "Bulk circular references could not be resolved.", "invalidValue");
        completed.set(index, {
          method: operation.method,
          bulkId: operation.bulkId,
          status: "409",
          response: await error.json(),
        });
      }
      break;
    }
    const [{ operation, index }] = pending.splice(ready_index, 1);
    const result = await execute_operation(operation, server, origin, ids);
    completed.set(index, result);
    if (Number(result.status) >= 400) errors += 1;
    if (validation.data.failOnErrors && errors >= validation.data.failOnErrors) break;
  }

  return json_response(
    {
      schemas: [BULK_RESPONSE_SCHEMA_URI],
      Operations: [...completed.entries()].sort(([left], [right]) => left - right).map(([, operation]) => operation),
    },
    BulkResponse,
  );
}
