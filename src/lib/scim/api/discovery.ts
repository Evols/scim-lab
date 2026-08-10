import type { ScimServerRecord } from "../../../db/schema.ts";
import { paginate } from "../server/pagination.ts";
import { get_service_provider_config, RESOURCE_TYPES, SCHEMA_DEFINITIONS } from "../server/discovery.ts";
import {
  ResourceType,
  ResourceTypeListResponse,
  SchemaDefinition,
  SchemaListResponse,
  ServiceProviderConfig,
} from "../schemas.ts";
import { scim_error } from "./error.ts";
import { json_response } from "./response.ts";

export function discovery_response(
  resource: string | undefined,
  resource_id: string | undefined,
  server: ScimServerRecord,
  url: URL,
): Response {
  const base = `${url.origin}${url.pathname.split(`/${resource ?? ""}`)[0]}`;
  if (url.searchParams.has("filter") && ["Schemas", "ResourceTypes"].includes(resource ?? "")) {
    return scim_error(403, "Filtering discovery resources is not supported.");
  }
  if (resource === "ServiceProviderConfig") {
    const location = `${base}/ServiceProviderConfig`;
    return json_response(
      {
        ...get_service_provider_config(server),
        meta: {
          resourceType: "ServiceProviderConfig",
          location,
        },
      },
      ServiceProviderConfig,
      200,
      { location, "content-location": location },
    );
  }
  if (resource === "Schemas") {
    const resources = SCHEMA_DEFINITIONS.map((definition) => ({
      ...definition,
      meta: {
        resourceType: "Schema",
        location: `${base}/Schemas/${definition.id}`,
      },
    }));
    const match = resource_id
      ? resources.find((definition) => definition.id === decodeURIComponent(resource_id))
      : null;
    return resource_id
      ? match
        ? json_response(match, SchemaDefinition, 200, {
            location: match.meta.location,
            "content-location": match.meta.location,
          })
        : scim_error(404, "Schema not found.")
      : json_response(paginate(resources, { start_index: "1", count: String(resources.length) }), SchemaListResponse);
  }
  if (resource === "ResourceTypes") {
    const resources = RESOURCE_TYPES.map((resource_type) => ({
      ...resource_type,
      meta: {
        resourceType: "ResourceType",
        location: `${base}/ResourceTypes/${resource_type.id}`,
      },
    }));
    const match = resource_id ? resources.find((resource_type) => resource_type.id === resource_id) : null;
    return resource_id
      ? match
        ? json_response(match, ResourceType, 200, {
            location: match.meta.location,
            "content-location": match.meta.location,
          })
        : scim_error(404, "Resource type not found.")
      : json_response(
          paginate(resources, { start_index: "1", count: String(resources.length) }),
          ResourceTypeListResponse,
        );
  }
  return scim_error(404, "SCIM resource not found.");
}
