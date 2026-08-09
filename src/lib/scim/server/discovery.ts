import type { ScimServerRecord } from "../../../db/schema.ts";
import {
  GROUP_SCHEMA_URI,
  RESOURCE_TYPE_SCHEMA_URI,
  SCHEMA_DEFINITION_URI,
  SERVICE_PROVIDER_CONFIG_SCHEMA_URI,
  USER_SCHEMA_URI,
} from "./constants.ts";
import { ResourceType, SchemaDefinition, ServiceProviderConfig } from "../schemas.ts";

export function get_service_provider_config(server: ScimServerRecord): ServiceProviderConfig {
  return ServiceProviderConfig.parse({
    schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA_URI],
    documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      server.auth_mode === "bearer"
        ? {
            type: "oauthbearertoken",
            name: "Bearer token",
            description: "Server-generated bearer token",
            specUri: "https://www.rfc-editor.org/rfc/rfc6750",
            primary: true,
          }
        : {
            type: "httpbasic",
            name: "HTTP Basic",
            description: "Server-generated username and password",
            specUri: "https://www.rfc-editor.org/rfc/rfc7617",
            primary: true,
          },
    ],
  });
}

// These definitions describe the subset of core SCIM attributes this lab accepts.
export const SCHEMA_DEFINITIONS = SchemaDefinition.array().parse([
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: USER_SCHEMA_URI,
    name: "User",
    description: "SCIM core User",
    attributes: [
      {
        name: "userName",
        type: "string",
        multiValued: false,
        required: true,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "server",
      },
      {
        name: "name",
        type: "complex",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: ["formatted", "familyName", "givenName", "middleName", "honorificPrefix", "honorificSuffix"].map(
          (name) => ({
            name,
            type: "string",
            multiValued: false,
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          }),
        ),
      },
      {
        name: "displayName",
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      ...["nickName", "profileUrl", "title", "userType", "preferredLanguage", "locale", "timezone"].map((name) => ({
        name,
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      })),
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
      {
        name: "password",
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "writeOnly",
        returned: "never",
        uniqueness: "none",
      },
      ...["emails", "phoneNumbers", "ims", "photos", "addresses"].map((name) => ({
        name,
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
      })),
      ...["entitlements", "roles", "x509Certificates"].map((name) => ({
        name,
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
      })),
      {
        name: "groups",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readOnly",
        returned: "default",
      },
    ],
  },
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: GROUP_SCHEMA_URI,
    name: "Group",
    description: "SCIM core Group",
    attributes: [
      {
        name: "displayName",
        type: "string",
        multiValued: false,
        required: true,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "members",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
    ],
  },
]);

export const RESOURCE_TYPES = ResourceType.array().parse([
  {
    schemas: [RESOURCE_TYPE_SCHEMA_URI],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: USER_SCHEMA_URI,
  },
  {
    schemas: [RESOURCE_TYPE_SCHEMA_URI],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: GROUP_SCHEMA_URI,
  },
]);
