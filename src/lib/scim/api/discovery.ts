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
  if (resource === "ServiceProviderConfig") {
    return json_response(get_service_provider_config(server), ServiceProviderConfig);
  }
  if (resource === "Schemas") {
    const match = resource_id
      ? SCHEMA_DEFINITIONS.find((definition) => definition.id === decodeURIComponent(resource_id))
      : null;
    return resource_id
      ? match
        ? json_response(match, SchemaDefinition)
        : scim_error(404, "Schema not found.")
      : json_response(paginate(SCHEMA_DEFINITIONS, url), SchemaListResponse);
  }
  if (resource === "ResourceTypes") {
    const match = resource_id ? RESOURCE_TYPES.find((resource_type) => resource_type.id === resource_id) : null;
    return resource_id
      ? match
        ? json_response(match, ResourceType)
        : scim_error(404, "Resource type not found.")
      : json_response(paginate(RESOURCE_TYPES, url), ResourceTypeListResponse);
  }
  return scim_error(404, "SCIM resource not found.");
}
