import { eq } from "drizzle-orm";
import { get_server_lifecycle } from "../../management/server";
import { db } from "../../database";
import { console_users, scim_servers } from "../../../db/schema.ts";
import { authenticate } from "./auth.ts";
import { discovery_response } from "./discovery.ts";
import { scim_error } from "./error.ts";
import { record_event } from "./events.ts";
import { handle_groups } from "./groups.ts";
import { handle_users } from "./users.ts";

export async function handle_scim_request(
  request: Request,
  server_id: string,
  path: string | undefined,
): Promise<Response> {
  const started_at = Date.now();
  // Keep the original body for event logging; parsed Zod objects may omit
  // unknown fields from nested structures.
  const raw_body = ["POST", "PUT", "PATCH"].includes(request.method) ? await request.text() : "";
  const rows = await db
    .select({ server: scim_servers, creator: console_users })
    .from(scim_servers)
    .innerJoin(console_users, eq(scim_servers.created_by_user_id, console_users.id))
    .where(eq(scim_servers.id, server_id))
    .limit(1);
  if (!rows[0]) {
    return scim_error(404, "SCIM server not found.");
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
      if (resource === "Users") {
        response = await handle_users(request.method, resource_id, server, url.origin, url, raw_body);
      } else if (resource === "Groups") {
        response = await handle_groups(request.method, resource_id, server, url.origin, url, raw_body);
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
