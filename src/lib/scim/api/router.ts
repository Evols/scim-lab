import { eq } from "drizzle-orm";
import { get_server_lifecycle } from "../../management/server";
import { db } from "../../database";
import { console_users, scim_servers } from "../../../db/schema.ts";
import { materialize_workspace, ProvisioningLimitError, read_bootstrap_bearer } from "../../session/anonymous.ts";
import { authenticate } from "./auth.ts";
import { discovery_response } from "./discovery.ts";
import { scim_error } from "./error.ts";
import { record_event } from "./events.ts";
import { handle_groups } from "./groups.ts";
import { handle_users } from "./users.ts";
import { bulk_response } from "./bulk.ts";
import { search_response } from "./search.ts";

export async function handle_scim_request(
  request: Request,
  server_id: string,
  path: string | undefined,
  client_address?: string,
): Promise<Response> {
  const started_at = Date.now();
  // Keep the original body for event logging; parsed Zod objects may omit
  // unknown fields from nested structures.
  const raw_body = ["POST", "PUT", "PATCH"].includes(request.method) ? await request.text() : "";
  const find_server = () =>
    db
      .select({ server: scim_servers, creator: console_users })
      .from(scim_servers)
      .innerJoin(console_users, eq(scim_servers.created_by_user_id, console_users.id))
      .where(eq(scim_servers.id, server_id))
      .limit(1);
  let rows = await find_server();
  if (!rows[0]) {
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const workspace = token ? read_bootstrap_bearer(token, server_id) : null;
    if (!workspace) return scim_error(404, "SCIM server not found.");
    try {
      await materialize_workspace(workspace, db, client_address ?? "");
    } catch (error) {
      if (error instanceof ProvisioningLimitError) {
        const response = scim_error(429, error.message);
        response.headers.set("retry-after", "60");
        return response;
      }
      // Consumed bootstrap credentials must never resurrect deleted servers.
      if (error instanceof Error && error.message === "This temporary workspace is no longer available.") {
        return scim_error(404, "SCIM server not found.");
      }
      throw error;
    }
    rows = await find_server();
    if (!rows[0]) return scim_error(404, "SCIM server not found.");
  }

  const { server, creator } = rows[0];
  const auth = authenticate(server, request.headers.get("authorization"));
  let response: Response;
  if (!auth.success) {
    response = scim_error(401, "Invalid or missing SCIM credentials.");
    response.headers.set(
      "www-authenticate",
      server.auth_mode === "bearer" ? 'Bearer realm="SCIM Lab"' : 'Basic realm="SCIM Lab", charset="UTF-8"',
    );
  } else if (get_server_lifecycle(server, creator.is_anonymous) === "expired") {
    // Expired servers are removed on access. Return before event logging because
    // deleting the server also cascades its event records.
    await db.delete(scim_servers).where(eq(scim_servers.id, server.id));
    return scim_error(404, "SCIM server not found.");
  } else if (get_server_lifecycle(server, creator.is_anonymous) !== "active") {
    response = scim_error(503, "This SCIM server is deactivated. Open its console to reactivate it.");
  } else if (
    ["POST", "PUT", "PATCH"].includes(request.method) &&
    !/^(application\/scim\+json|application\/json)(?:;|$)/i.test(request.headers.get("content-type") ?? "")
  ) {
    response = scim_error(415, "SCIM writes require application/scim+json.", "invalidSyntax");
  } else {
    const segments = (path ?? "").split("/").filter(Boolean);
    const [resource, resource_id] = segments;
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && resource === "Bulk" && !resource_id) {
        response = await bulk_response(server, url.origin, raw_body);
      } else if (request.method === "POST" && resource === ".search" && !resource_id) {
        response = await search_response("root", server, url.origin, url, raw_body);
      } else if (
        request.method === "POST" &&
        resource_id === ".search" &&
        (resource === "Users" || resource === "Groups")
      ) {
        response = await search_response(resource, server, url.origin, url, raw_body);
      } else if (request.method === "GET" && !resource) {
        response = await search_response("root", server, url.origin, url);
      } else if (resource === "Users" && segments.length <= 2) {
        response = await handle_users(request.method, resource_id, server, url.origin, url, raw_body, request.headers);
      } else if (resource === "Groups" && segments.length <= 2) {
        response = await handle_groups(request.method, resource_id, server, url.origin, url, raw_body, request.headers);
      } else if (segments.length > 2) {
        response = scim_error(404, "SCIM resource not found.");
      } else if (request.method !== "GET") {
        response = scim_error(405, "Method not allowed.");
      } else response = discovery_response(resource, resource_id, server, url);
    } catch (error) {
      console.error("SCIM request failed", error);
      response = scim_error(500, "The SCIM server could not complete this request.");
    }
  }

  await record_event(server.id, request, response, raw_body, started_at, auth.mode, auth.success);
  return response;
}
