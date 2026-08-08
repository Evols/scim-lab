import * as z from "zod";
import { GROUP_SCHEMA, LIST_SCHEMA, USER_SCHEMA } from "./constants.ts";

const nullable_string = z.string().nullable();
const nullable_boolean = z.boolean().nullable();

const name_schema = z.looseObject({
  formatted: nullable_string.optional(),
  familyName: nullable_string.optional(),
  givenName: nullable_string.optional(),
  middleName: nullable_string.optional(),
  honorificPrefix: nullable_string.optional(),
  honorificSuffix: nullable_string.optional(),
});

const multi_valued_attribute_schema = z.looseObject({
  value: nullable_string.optional(),
  display: nullable_string.optional(),
  type: nullable_string.optional(),
  primary: nullable_boolean.optional(),
  $ref: nullable_string.optional(),
});

const address_schema = z.looseObject({
  formatted: nullable_string.optional(),
  streetAddress: nullable_string.optional(),
  locality: nullable_string.optional(),
  region: nullable_string.optional(),
  postalCode: nullable_string.optional(),
  country: nullable_string.optional(),
  type: nullable_string.optional(),
  primary: nullable_boolean.optional(),
});

const user_data_attributes = {
  name: name_schema.nullable().optional(),
  nickName: nullable_string.optional(),
  profileUrl: nullable_string.optional(),
  title: nullable_string.optional(),
  userType: nullable_string.optional(),
  preferredLanguage: nullable_string.optional(),
  locale: nullable_string.optional(),
  timezone: nullable_string.optional(),
  emails: z.array(multi_valued_attribute_schema).nullable().optional(),
  phoneNumbers: z.array(multi_valued_attribute_schema).nullable().optional(),
  ims: z.array(multi_valued_attribute_schema).nullable().optional(),
  photos: z.array(multi_valued_attribute_schema).nullable().optional(),
  addresses: z.array(address_schema).nullable().optional(),
  entitlements: z.array(multi_valued_attribute_schema).nullable().optional(),
  roles: z.array(multi_valued_attribute_schema).nullable().optional(),
  x509Certificates: z
    .array(multi_valued_attribute_schema)
    .nullable()
    .optional(),
};

const user_attributes = {
  schemas: z.array(z.string()).nullable().optional(),
  externalId: nullable_string.optional(),
  userName: nullable_string.optional(),
  displayName: nullable_string.optional(),
  active: nullable_boolean.optional(),
  password: nullable_string.optional(),
  ...user_data_attributes,
};

// Database JSON holds only the flexible attributes, never identity or metadata.
export const user_data_schema = z.object(user_data_attributes);
export type UserData = z.infer<typeof user_data_schema>;

// Loose objects preserve extension URNs and vendor attributes. The known core
// attributes still receive runtime validation and useful inferred types.
export const user_write_schema = z.looseObject(user_attributes);
export type UserWriteInput = z.infer<typeof user_write_schema>;

export const group_member_schema = z.looseObject({
  value: z.string(),
  display: nullable_string.optional(),
  $ref: nullable_string.optional(),
  type: nullable_string.optional(),
});
export type GroupMember = z.infer<typeof group_member_schema>;

export const group_write_schema = z.looseObject({
  schemas: z.array(z.string()).nullable().optional(),
  externalId: nullable_string.optional(),
  displayName: nullable_string.optional(),
  members: z.array(group_member_schema).nullable().optional(),
});
export type GroupWriteInput = z.infer<typeof group_write_schema>;

export const patch_operation_schema = z.looseObject({
  op: z.string(),
  path: nullable_string.optional(),
  value: z.unknown().optional(),
});
export type PatchOperation = z.infer<typeof patch_operation_schema>;

export const patch_request_schema = z.looseObject({
  schemas: z.array(z.string()).nullable().optional(),
  Operations: z.array(patch_operation_schema),
});
export type PatchRequest = z.infer<typeof patch_request_schema>;

const resource_reference_schema = z.looseObject({
  value: z.string(),
  display: z.string().optional(),
  $ref: z.string().optional(),
});

const resource_meta_schema = z.object({
  resourceType: z.string(),
  created: z.string(),
  lastModified: z.string(),
  version: z.string(),
  location: z.string(),
});

export const user_resource_schema = z.looseObject({
  ...user_attributes,
  schemas: z.tuple([z.literal(USER_SCHEMA)]),
  id: z.string(),
  userName: z.string(),
  displayName: z.string().optional(),
  active: z.boolean(),
  groups: z.array(resource_reference_schema),
  meta: resource_meta_schema.extend({ resourceType: z.literal("User") }),
});
export type UserResource = z.infer<typeof user_resource_schema>;

export const group_resource_schema = z.looseObject({
  schemas: z.tuple([z.literal(GROUP_SCHEMA)]),
  id: z.string(),
  externalId: z.string().optional(),
  displayName: z.string(),
  members: z.array(resource_reference_schema),
  meta: resource_meta_schema.extend({ resourceType: z.literal("Group") }),
});
export type GroupResource = z.infer<typeof group_resource_schema>;
export type ScimResource = UserResource | GroupResource;

export function list_response_schema<S extends z.ZodType>(resource_schema: S) {
  return z.object({
    schemas: z.tuple([z.literal(LIST_SCHEMA)]),
    totalResults: z.number().int().nonnegative(),
    startIndex: z.number().int().positive(),
    itemsPerPage: z.number().int().nonnegative(),
    Resources: z.array(resource_schema),
  });
}

export const user_list_response_schema =
  list_response_schema(user_resource_schema);
export type UserListResponse = z.infer<typeof user_list_response_schema>;
export const group_list_response_schema = list_response_schema(
  group_resource_schema,
);
export type GroupListResponse = z.infer<typeof group_list_response_schema>;

export const scim_error_schema = z.object({
  schemas: z.tuple([z.literal("urn:ietf:params:scim:api:messages:2.0:Error")]),
  status: z.string(),
  scimType: z.string().optional(),
  detail: z.string(),
});

const supported_schema = z.looseObject({ supported: z.boolean() });
export const service_provider_config_schema = z.looseObject({
  schemas: z.array(z.string()),
  documentationUri: z.string(),
  patch: supported_schema,
  bulk: supported_schema,
  filter: supported_schema,
  changePassword: supported_schema,
  sort: supported_schema,
  etag: supported_schema,
  authenticationSchemes: z.array(
    z.looseObject({
      type: z.string(),
      name: z.string(),
      description: z.string(),
      specUri: z.string(),
      primary: z.boolean(),
    }),
  ),
});
export type ServiceProviderConfig = z.infer<
  typeof service_provider_config_schema
>;

export const schema_document_schema = z.looseObject({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  attributes: z.array(z.looseObject({ name: z.string(), type: z.string() })),
});
export type SchemaDocument = z.infer<typeof schema_document_schema>;
export const schema_document_list_schema = list_response_schema(
  schema_document_schema,
);

export const resource_type_schema = z.looseObject({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  schema: z.string(),
});
export type ResourceType = z.infer<typeof resource_type_schema>;
export const resource_type_list_schema =
  list_response_schema(resource_type_schema);
