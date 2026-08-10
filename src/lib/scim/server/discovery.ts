import type { ScimServerRecord } from "../../../db/schema.ts";
import { ResourceType, SchemaDefinition, ServiceProviderConfig, type SchemaDefinition as Schema } from "../schemas.ts";
import {
  ENTERPRISE_USER_SCHEMA_URI,
  GROUP_SCHEMA_URI,
  RESOURCE_TYPE_SCHEMA_URI,
  SCHEMA_DEFINITION_URI,
  SERVICE_PROVIDER_CONFIG_SCHEMA_URI,
  USER_SCHEMA_URI,
} from "./constants.ts";

type Attribute = Schema["attributes"][number];

const string_attribute = (name: string, options: Partial<Attribute> = {}): Attribute => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...options,
});

const boolean_attribute = (name: string, options: Partial<Attribute> = {}): Attribute => ({
  name,
  type: "boolean",
  multiValued: false,
  required: false,
  mutability: "readWrite",
  returned: "default",
  ...options,
});

const integer_attribute = (name: string, options: Partial<Attribute> = {}): Attribute => ({
  name,
  type: "integer",
  multiValued: false,
  required: false,
  mutability: "readWrite",
  returned: "default",
  ...options,
});

const reference_attribute = (name: string, referenceTypes: string[], options: Partial<Attribute> = {}): Attribute => ({
  ...string_attribute(name),
  type: "reference",
  referenceTypes,
  ...options,
});

const common_multi_subattributes = () => [
  string_attribute("value"),
  string_attribute("display"),
  string_attribute("type"),
  boolean_attribute("primary"),
];

const complex_multi = (
  name: string,
  subAttributes = common_multi_subattributes(),
  options: Partial<Attribute> = {},
): Attribute => ({
  name,
  type: "complex",
  multiValued: true,
  required: false,
  mutability: "readWrite",
  returned: "default",
  subAttributes,
  ...options,
});

export function get_service_provider_config(server: ScimServerRecord): ServiceProviderConfig {
  return ServiceProviderConfig.parse({
    schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA_URI],
    documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
    patch: { supported: true },
    bulk: { supported: true, maxOperations: 100, maxPayloadSize: 1_048_576 },
    filter: { supported: true, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: true },
    etag: { supported: true },
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

const user_attributes: Attribute[] = [
  string_attribute("userName", { required: true, uniqueness: "server" }),
  {
    name: "name",
    type: "complex",
    multiValued: false,
    required: false,
    mutability: "readWrite",
    returned: "default",
    subAttributes: ["formatted", "familyName", "givenName", "middleName", "honorificPrefix", "honorificSuffix"].map(
      (name) => string_attribute(name),
    ),
  },
  string_attribute("displayName"),
  string_attribute("nickName"),
  string_attribute("profileUrl", { type: "reference", referenceTypes: ["external"] }),
  string_attribute("title"),
  string_attribute("userType"),
  string_attribute("preferredLanguage"),
  string_attribute("locale"),
  string_attribute("timezone", { caseExact: true }),
  boolean_attribute("active"),
  string_attribute("password", { mutability: "writeOnly", returned: "never" }),
  complex_multi(
    "emails",
    common_multi_subattributes().map((attribute) =>
      attribute.name === "type" ? { ...attribute, canonicalValues: ["work", "home", "other"] } : attribute,
    ),
  ),
  complex_multi(
    "phoneNumbers",
    common_multi_subattributes().map((attribute) =>
      attribute.name === "type"
        ? { ...attribute, canonicalValues: ["work", "home", "mobile", "fax", "pager", "other"] }
        : attribute,
    ),
  ),
  complex_multi(
    "ims",
    common_multi_subattributes().map((attribute) =>
      attribute.name === "type"
        ? { ...attribute, canonicalValues: ["aim", "gtalk", "icq", "xmpp", "msn", "skype", "qq", "yahoo"] }
        : attribute,
    ),
  ),
  complex_multi("photos", [
    string_attribute("value", { type: "reference", referenceTypes: ["external"] }),
    string_attribute("display"),
    string_attribute("type", { canonicalValues: ["photo", "thumbnail"] }),
    boolean_attribute("primary"),
  ]),
  complex_multi("addresses", [
    ...["formatted", "streetAddress", "locality", "region", "postalCode", "country"].map((name) =>
      string_attribute(name),
    ),
    string_attribute("type", { canonicalValues: ["work", "home", "other"] }),
    boolean_attribute("primary"),
  ]),
  complex_multi(
    "groups",
    [
      string_attribute("value", { mutability: "readOnly" }),
      string_attribute("$ref", { type: "reference", referenceTypes: ["Group"], mutability: "readOnly" }),
      string_attribute("display", { mutability: "readOnly" }),
      string_attribute("type", { canonicalValues: ["direct", "indirect"], mutability: "readOnly" }),
    ],
    { mutability: "readOnly" },
  ),
  complex_multi("entitlements"),
  complex_multi("roles"),
  complex_multi("x509Certificates", [string_attribute("value", { type: "binary", caseExact: true })]),
];

const group_attributes: Attribute[] = [
  string_attribute("displayName", { required: true }),
  complex_multi("members", [
    string_attribute("value", { mutability: "immutable" }),
    string_attribute("$ref", { type: "reference", referenceTypes: ["User", "Group"], mutability: "immutable" }),
    string_attribute("type", { canonicalValues: ["User", "Group"], mutability: "immutable" }),
    string_attribute("display", { mutability: "immutable" }),
  ]),
];

const enterprise_attributes: Attribute[] = [
  ...["employeeNumber", "costCenter", "organization", "division", "department"].map((name) => string_attribute(name)),
  {
    name: "manager",
    type: "complex",
    multiValued: false,
    required: false,
    mutability: "readWrite",
    returned: "default",
    subAttributes: [
      string_attribute("value"),
      string_attribute("$ref", { type: "reference", referenceTypes: ["User"] }),
      string_attribute("displayName", { mutability: "readOnly" }),
    ],
  },
];

const read_only = { mutability: "readOnly" } as const;
const supported_subattribute = boolean_attribute("supported", { required: true, ...read_only });
const service_provider_attributes: Attribute[] = [
  reference_attribute("documentationUri", ["external"], read_only),
  ...["patch", "changePassword", "sort", "etag"].map(
    (name) =>
      ({
        name,
        type: "complex",
        multiValued: false,
        required: true,
        mutability: "readOnly",
        returned: "default",
        subAttributes: [supported_subattribute],
      }) satisfies Attribute,
  ),
  {
    name: "bulk",
    type: "complex",
    multiValued: false,
    required: true,
    mutability: "readOnly",
    returned: "default",
    subAttributes: [
      supported_subattribute,
      integer_attribute("maxOperations", { required: true, ...read_only }),
      integer_attribute("maxPayloadSize", { required: true, ...read_only }),
    ],
  },
  {
    name: "filter",
    type: "complex",
    multiValued: false,
    required: true,
    mutability: "readOnly",
    returned: "default",
    subAttributes: [supported_subattribute, integer_attribute("maxResults", { required: true, ...read_only })],
  },
  {
    name: "authenticationSchemes",
    type: "complex",
    multiValued: true,
    required: true,
    mutability: "readOnly",
    returned: "default",
    subAttributes: [
      string_attribute("type", {
        required: true,
        canonicalValues: ["oauth", "oauth2", "oauthbearertoken", "httpbasic", "httpdigest"],
        ...read_only,
      }),
      string_attribute("name", { required: true, ...read_only }),
      string_attribute("description", { required: true, ...read_only }),
      reference_attribute("specUri", ["external"], read_only),
      reference_attribute("documentationUri", ["external"], read_only),
      boolean_attribute("primary", read_only),
    ],
  },
];

const resource_type_attributes: Attribute[] = [
  string_attribute("id", { required: true, caseExact: true, returned: "always", uniqueness: "server", ...read_only }),
  string_attribute("name", { required: true, ...read_only }),
  string_attribute("description", read_only),
  reference_attribute("endpoint", ["uri"], { required: true, ...read_only }),
  reference_attribute("schema", ["uri"], { required: true, ...read_only }),
  complex_multi(
    "schemaExtensions",
    [
      reference_attribute("schema", ["uri"], { required: true, ...read_only }),
      boolean_attribute("required", { required: true, ...read_only }),
    ],
    read_only,
  ),
];

const schema_attribute_characteristics = [
  string_attribute("name", { required: true, ...read_only }),
  string_attribute("type", {
    required: true,
    canonicalValues: ["string", "complex", "boolean", "decimal", "integer", "dateTime", "reference", "binary"],
    ...read_only,
  }),
  boolean_attribute("multiValued", { required: true, ...read_only }),
  string_attribute("description", read_only),
  boolean_attribute("required", { required: true, ...read_only }),
  { ...string_attribute("canonicalValues", read_only), multiValued: true },
  boolean_attribute("caseExact", { required: true, ...read_only }),
  string_attribute("mutability", {
    required: true,
    canonicalValues: ["readOnly", "readWrite", "immutable", "writeOnly"],
    ...read_only,
  }),
  string_attribute("returned", {
    required: true,
    canonicalValues: ["always", "never", "default", "request"],
    ...read_only,
  }),
  string_attribute("uniqueness", {
    required: true,
    canonicalValues: ["none", "server", "global"],
    ...read_only,
  }),
  { ...reference_attribute("referenceTypes", ["uri"], read_only), multiValued: true },
  { ...string_attribute("subAttributes", { type: "complex", ...read_only }), multiValued: true },
];

const schema_definition_attributes: Attribute[] = [
  reference_attribute("id", ["uri"], {
    required: true,
    caseExact: true,
    returned: "always",
    uniqueness: "server",
    ...read_only,
  }),
  string_attribute("name", { required: true, ...read_only }),
  string_attribute("description", read_only),
  complex_multi("attributes", schema_attribute_characteristics, { required: true, ...read_only }),
];

export const SCHEMA_DEFINITIONS = SchemaDefinition.array().parse([
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: USER_SCHEMA_URI,
    name: "User",
    description: "User Account",
    attributes: user_attributes,
  },
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: GROUP_SCHEMA_URI,
    name: "Group",
    description: "Group",
    attributes: group_attributes,
  },
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: ENTERPRISE_USER_SCHEMA_URI,
    name: "EnterpriseUser",
    description: "Enterprise User",
    attributes: enterprise_attributes,
  },
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: SERVICE_PROVIDER_CONFIG_SCHEMA_URI,
    name: "Service Provider Configuration",
    description: "Schema for representing the service provider's configuration",
    attributes: service_provider_attributes,
  },
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: RESOURCE_TYPE_SCHEMA_URI,
    name: "ResourceType",
    description: "Specifies the schema and endpoint for a resource type",
    attributes: resource_type_attributes,
  },
  {
    schemas: [SCHEMA_DEFINITION_URI],
    id: SCHEMA_DEFINITION_URI,
    name: "Schema",
    description: "Defines a SCIM schema and its attributes",
    attributes: schema_definition_attributes,
  },
]);

export const RESOURCE_TYPES = ResourceType.array().parse([
  {
    schemas: [RESOURCE_TYPE_SCHEMA_URI],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "User Account",
    schema: USER_SCHEMA_URI,
    schemaExtensions: [{ schema: ENTERPRISE_USER_SCHEMA_URI, required: false }],
  },
  {
    schemas: [RESOURCE_TYPE_SCHEMA_URI],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    description: "Group",
    schema: GROUP_SCHEMA_URI,
  },
]);
