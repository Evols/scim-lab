import type { ScimServerRecord } from "../../../db/schema.ts";
import {
  create_group,
  delete_group,
  get_group,
  list_groups,
  patch_group,
  replace_group,
} from "../services/groups.ts";
import { base_url } from "../services/resources.ts";
import {
  group_list_response_schema,
  group_resource_schema,
  group_write_schema,
  patch_request_schema,
} from "../schemas.ts";
import { validate_json_body } from "./body.ts";
import { scim_error } from "./error.ts";
import { json_response } from "./response.ts";
import { service_error_response } from "./service-error.ts";

async function route_groups(
  method: string,
  resource_id: string | undefined,
  server: ScimServerRecord,
  origin: string,
  url: URL,
  body: string,
): Promise<Response> {
  if (method === "GET" && resource_id)
    return json_response(
      await get_group(server.id, resource_id, origin),
      group_resource_schema,
    );

  if (method === "GET") {
    const result = await list_groups(server.id, origin, {
      filter: url.searchParams.get("filter"),
      start_index: url.searchParams.get("startIndex"),
      count: url.searchParams.get("count"),
    });
    return json_response(result, group_list_response_schema);
  }

  if (method === "POST" && !resource_id) {
    const validation = validate_json_body(body, group_write_schema);
    if (!validation.success) return validation.response;
    const resource = await create_group(server.id, validation.data, origin);
    return json_response(resource, group_resource_schema, 201, {
      location: `${base_url(origin, server.id)}/Groups/${resource.id}`,
    });
  }

  if (!resource_id)
    return scim_error(405, "This method requires a group resource ID.");
  if (method === "DELETE") {
    await delete_group(server.id, resource_id);
    return new Response(null, { status: 204 });
  }
  if (method === "PUT") {
    const validation = validate_json_body(body, group_write_schema);
    if (!validation.success) return validation.response;
    return json_response(
      await replace_group(server.id, resource_id, validation.data, origin),
      group_resource_schema,
    );
  }
  if (method === "PATCH") {
    const validation = validate_json_body(body, patch_request_schema);
    if (!validation.success) return validation.response;
    return json_response(
      await patch_group(
        server.id,
        resource_id,
        validation.data.Operations,
        origin,
      ),
      group_resource_schema,
    );
  }

  await get_group(server.id, resource_id, origin);
  return scim_error(405, "Method not allowed.");
}

export async function handle_groups(
  method: string,
  resource_id: string | undefined,
  server: ScimServerRecord,
  origin: string,
  url: URL,
  body: string,
): Promise<Response> {
  try {
    return await route_groups(method, resource_id, server, origin, url, body);
  } catch (error) {
    const response = service_error_response(error);
    if (response) return response;
    throw error;
  }
}
