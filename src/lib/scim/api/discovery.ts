import type { ScimServerRecord } from "../../../db/schema.ts";
import { paginate } from "../pagination.ts";
import {
  resource_types,
  schema_documents,
  service_provider_config,
} from "../services/discovery.ts";
import {
  resource_type_list_schema,
  resource_type_schema,
  schema_document_list_schema,
  schema_document_schema,
  service_provider_config_schema,
} from "../schemas.ts";
import { scim_error } from "./error.ts";
import { json_response } from "./response.ts";

export function discovery_response(
  resource: string | undefined,
  resource_id: string | undefined,
  server: ScimServerRecord,
  url: URL,
): Response {
  if (resource === "ServiceProviderConfig")
    return json_response(
      service_provider_config(server),
      service_provider_config_schema,
    );
  if (resource === "Schemas") {
    const match = resource_id
      ? schema_documents.find(
          (schema) => schema.id === decodeURIComponent(resource_id),
        )
      : null;
    return resource_id
      ? match
        ? json_response(match, schema_document_schema)
        : scim_error(404, "Schema not found.")
      : json_response(
          paginate(schema_documents, url),
          schema_document_list_schema,
        );
  }
  if (resource === "ResourceTypes") {
    const match = resource_id
      ? resource_types.find((resource_type) => resource_type.id === resource_id)
      : null;
    return resource_id
      ? match
        ? json_response(match, resource_type_schema)
        : scim_error(404, "Resource type not found.")
      : json_response(paginate(resource_types, url), resource_type_list_schema);
  }
  return scim_error(404, "SCIM resource not found.");
}
