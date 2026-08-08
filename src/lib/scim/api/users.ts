import type { scim_server_record } from "../../../db/schema.ts";
import {
  create_user,
  delete_user,
  get_user,
  list_users,
  patch_user,
  replace_user,
} from "../services/users.ts";
import { base_url } from "../services/resources.ts";
import {
  patch_request_schema,
  user_list_response_schema,
  user_resource_schema,
  user_write_schema,
} from "../schemas.ts";
import { validate_json_body } from "./body.ts";
import { scim_error } from "./error.ts";
import { json_response } from "./response.ts";
import { service_error_response } from "./service-error.ts";

async function route_users(
  method: string,
  resource_id: string | undefined,
  server: scim_server_record,
  origin: string,
  url: URL,
  body: string,
): Promise<Response> {
  if (method === "GET" && resource_id)
    return json_response(
      await get_user(server.id, resource_id, origin),
      user_resource_schema,
    );

  if (method === "GET") {
    const result = await list_users(server.id, origin, {
      filter: url.searchParams.get("filter"),
      start_index: url.searchParams.get("startIndex"),
      count: url.searchParams.get("count"),
    });
    return json_response(result, user_list_response_schema);
  }

  if (method === "POST" && resource_id === undefined) {
    const validation = validate_json_body(body, user_write_schema);
    if (!validation.success) return validation.response;
    const resource = await create_user(server.id, validation.data, origin);
    return json_response(resource, user_resource_schema, 201, {
      location: `${base_url(origin, server.id)}/Users/${resource.id}`,
    });
  }

  if (resource_id === undefined) {
    return scim_error(405, "This method requires a user resource ID.");
  }

  if (method === "DELETE") {
    await delete_user(server.id, resource_id);
    return new Response(null, { status: 204 });
  }

  if (method === "PUT") {
    const validation = validate_json_body(body, user_write_schema);
    if (!validation.success) return validation.response;
    return json_response(
      await replace_user(server.id, resource_id, validation.data, origin),
      user_resource_schema,
    );
  }
  if (method === "PATCH") {
    const validation = validate_json_body(body, patch_request_schema);
    if (!validation.success) return validation.response;
    return json_response(
      await patch_user(
        server.id,
        resource_id,
        validation.data.Operations,
        origin,
      ),
      user_resource_schema,
    );
  }

  // Preserve the distinction between an unknown resource and an unsupported
  // method without leaking persistence concerns into this API layer.
  await get_user(server.id, resource_id, origin);
  return scim_error(405, "Method not allowed.");
}

export async function handle_users(
  method: string,
  resource_id: string | undefined,
  server: scim_server_record,
  origin: string,
  url: URL,
  body: string,
): Promise<Response> {
  try {
    return await route_users(method, resource_id, server, origin, url, body);
  } catch (error) {
    const response = service_error_response(error);
    if (response) return response;
    throw error;
  }
}
