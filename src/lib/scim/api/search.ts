import type { ScimServerRecord } from "../../../db/schema.ts";
import { GenericListResponse, SearchRequest, type SearchRequest as SearchRequestBody } from "../schemas.ts";
import { list_groups, query_groups } from "../server/groups.ts";
import { paginate } from "../server/pagination.ts";
import { project_list, query_options, sort_resources, type QueryOptions } from "../server/query.ts";
import { list_users, query_users } from "../server/users.ts";
import { validate_json_body } from "./body.ts";
import { json_response } from "./response.ts";
import { service_error_response } from "./service-error.ts";

function body_query(body: SearchRequestBody): { options: QueryOptions; query: Parameters<typeof list_users>[2] } {
  return {
    options: {
      attributes: body.attributes,
      excluded_attributes: body.excludedAttributes,
      sort_by: body.sortBy,
      sort_order: body.sortOrder,
    },
    query: {
      filter: body.filter,
      start_index: body.startIndex == null ? null : String(body.startIndex),
      count: body.count == null ? null : String(body.count),
      sort_by: body.sortBy,
      sort_order: body.sortOrder,
    },
  };
}

export async function search_response(
  scope: "Users" | "Groups" | "root",
  server: ScimServerRecord,
  origin: string,
  url: URL,
  body?: string,
): Promise<Response> {
  try {
    let options: QueryOptions;
    let query: Parameters<typeof list_users>[2];
    if (body !== undefined) {
      const validation = validate_json_body(body, SearchRequest);
      if (!validation.success) return validation.response;
      ({ options, query } = body_query(validation.data));
    } else {
      options = query_options(url);
      query = {
        filter: url.searchParams.get("filter"),
        start_index: url.searchParams.get("startIndex"),
        count: url.searchParams.get("count"),
        sort_by: options.sort_by,
        sort_order: options.sort_order,
      };
    }

    if (scope === "Users") {
      const result = await list_users(server.id, origin, query);
      return json_response({ ...result, Resources: project_list(result.Resources, options) }, GenericListResponse);
    }
    if (scope === "Groups") {
      const result = await list_groups(server.id, origin, query);
      return json_response({ ...result, Resources: project_list(result.Resources, options) }, GenericListResponse);
    }

    // A server-root query spans every supported resource type.  Fetch each
    // complete local collection, then filter/sort/paginate the combined set.
    const [users, groups] = await Promise.all([
      query_users(server.id, origin, query),
      query_groups(server.id, origin, query),
    ]);
    const combined = sort_resources([...users, ...groups], query.sort_by, query.sort_order);
    const page = paginate(combined, query);
    return json_response({ ...page, Resources: project_list(page.Resources, options) }, GenericListResponse);
  } catch (error) {
    const response = service_error_response(error);
    if (response) return response;
    throw error;
  }
}
