import type { ScimServerRecord } from "../../../db/schema.ts";
import { paginate } from "../server/pagination.ts";
import { resource_types, schema_documents, service_provider_config } from "../server/discovery.ts";
import {
  ResourceTypeListSchema,
  ResourceType,
  SchemaDocumentListSchema,
  SchemaDocument,
  ServiceProviderConfigSchema,
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
    return json_response(service_provider_config(server), ServiceProviderConfigSchema);
  }
  if (resource === "Schemas") {
    const match = resource_id ? schema_documents.find((schema) => schema.id === decodeURIComponent(resource_id)) : null;
    return resource_id
      ? match
        ? json_response(match, SchemaDocument)
        : scim_error(404, "Schema not found.")
      : json_response(paginate(schema_documents, url), SchemaDocumentListSchema);
  }
  if (resource === "ResourceTypes") {
    const match = resource_id ? resource_types.find((resource_type) => resource_type.id === resource_id) : null;
    return resource_id
      ? match
        ? json_response(match, ResourceType)
        : scim_error(404, "Resource type not found.")
      : json_response(paginate(resource_types, url), ResourceTypeListSchema);
  }
  return scim_error(404, "SCIM resource not found.");
}
