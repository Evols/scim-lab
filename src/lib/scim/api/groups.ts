import type { ScimServerRecord } from "../../../db/schema.ts";
import { create_group, delete_group, get_group, list_groups, patch_group, replace_group } from "../server/groups.ts";
import { GenericListResponse, GroupInput, GroupResource, PatchRequest } from "../schemas.ts";
import { project_list, query_options } from "../server/query.ts";
import { validate_json_body } from "./body.ts";
import { scim_error } from "./error.ts";
import { json_response } from "./response.ts";
import { service_error_response } from "./service-error.ts";
import { check_if_match, resource_response } from "./conditional.ts";

async function route_groups(
  method: string,
  resource_id: string | undefined,
  server: ScimServerRecord,
  origin: string,
  url: URL,
  body: string,
  request_headers: Headers,
): Promise<Response> {
  const options = query_options(url);
  if (method === "GET" && resource_id) {
    return resource_response(await get_group(server.id, resource_id, origin), GroupResource, request_headers, options);
  }

  if (method === "GET") {
    const result = await list_groups(server.id, origin, {
      filter: url.searchParams.get("filter"),
      start_index: url.searchParams.get("startIndex"),
      count: url.searchParams.get("count"),
      sort_by: options.sort_by,
      sort_order: options.sort_order,
    });
    return json_response({ ...result, Resources: project_list(result.Resources, options) }, GenericListResponse);
  }

  if (method === "POST" && !resource_id) {
    const validation = validate_json_body(body, GroupInput);
    if (!validation.success) {
      return validation.response;
    }
    const resource = await create_group(server.id, validation.data, origin);
    return resource_response(resource, GroupResource, request_headers, options, 201);
  }

  if (!resource_id) {
    return scim_error(405, "This method requires a group resource ID.");
  }
  if (method === "DELETE") {
    const existing = await get_group(server.id, resource_id, origin);
    const failed = check_if_match(request_headers.get("if-match"), existing);
    if (failed) return failed;
    await delete_group(server.id, resource_id);
    return new Response(null, { status: 204 });
  }
  if (method === "PUT") {
    const existing = await get_group(server.id, resource_id, origin);
    const failed = check_if_match(request_headers.get("if-match"), existing);
    if (failed) return failed;
    const validation = validate_json_body(body, GroupInput);
    if (!validation.success) {
      return validation.response;
    }
    return resource_response(
      await replace_group(server.id, resource_id, validation.data, origin),
      GroupResource,
      request_headers,
      options,
    );
  }
  if (method === "PATCH") {
    const existing = await get_group(server.id, resource_id, origin);
    const failed = check_if_match(request_headers.get("if-match"), existing);
    if (failed) return failed;
    const validation = validate_json_body(body, PatchRequest);
    if (!validation.success) {
      return validation.response;
    }
    return resource_response(
      await patch_group(server.id, resource_id, validation.data.Operations, origin),
      GroupResource,
      request_headers,
      options,
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
  request_headers: Headers,
): Promise<Response> {
  try {
    return await route_groups(method, resource_id, server, origin, url, body, request_headers);
  } catch (error) {
    const response = service_error_response(error);
    if (response) {
      return response;
    }
    throw error;
  }
}
