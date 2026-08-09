import * as z from "zod";
import { ERROR_SCHEMA_URI, GROUP_SCHEMA_URI, LIST_RESPONSE_SCHEMA_URI, USER_SCHEMA_URI } from "./server/constants.ts";

const NullableString = z.string().nullable();
const NullableBoolean = z.boolean().nullable();

const NameAttribute = z.object({
  formatted: NullableString.optional(),
  familyName: NullableString.optional(),
  givenName: NullableString.optional(),
  middleName: NullableString.optional(),
  honorificPrefix: NullableString.optional(),
  honorificSuffix: NullableString.optional(),
});

const MultiValuedAttribute = z.object({
  value: NullableString.optional(),
  display: NullableString.optional(),
  type: NullableString.optional(),
  primary: NullableBoolean.optional(),
  $ref: NullableString.optional(),
});

const AddressAttribute = z.object({
  formatted: NullableString.optional(),
  streetAddress: NullableString.optional(),
  locality: NullableString.optional(),
  region: NullableString.optional(),
  postalCode: NullableString.optional(),
  country: NullableString.optional(),
  type: NullableString.optional(),
  primary: NullableBoolean.optional(),
});

const user_data_attributes = {
  name: NameAttribute.nullable().optional(),
  nickName: NullableString.optional(),
  profileUrl: NullableString.optional(),
  title: NullableString.optional(),
  userType: NullableString.optional(),
  preferredLanguage: NullableString.optional(),
  locale: NullableString.optional(),
  timezone: NullableString.optional(),
  emails: z.array(MultiValuedAttribute).nullable().optional(),
  phoneNumbers: z.array(MultiValuedAttribute).nullable().optional(),
  ims: z.array(MultiValuedAttribute).nullable().optional(),
  photos: z.array(MultiValuedAttribute).nullable().optional(),
  addresses: z.array(AddressAttribute).nullable().optional(),
  entitlements: z.array(MultiValuedAttribute).nullable().optional(),
  roles: z.array(MultiValuedAttribute).nullable().optional(),
  x509Certificates: z.array(MultiValuedAttribute).nullable().optional(),
};

const user_attributes = {
  schemas: z.array(z.string()).nullable().optional(),
  externalId: NullableString.optional(),
  userName: NullableString.optional(),
  displayName: NullableString.optional(),
  active: NullableBoolean.optional(),
  password: NullableString.optional(),
  ...user_data_attributes,
};

// Database JSON holds only the flexible attributes, never identity or metadata.
export const UserData = z.object(user_data_attributes);
export type UserData = z.infer<typeof UserData>;

// Loose objects preserve extension URNs and vendor attributes. The known core
// attributes still receive runtime validation and useful inferred types.
export const UserInput = z.looseObject(user_attributes);
export type UserInput = z.infer<typeof UserInput>;

export const GroupMember = z.object({
  value: z.string(),
  display: NullableString.optional(),
  $ref: NullableString.optional(),
  type: NullableString.optional(),
});
export type GroupMember = z.infer<typeof GroupMember>;

export const GroupInput = z.looseObject({
  schemas: z.array(z.string()).nullable().optional(),
  externalId: NullableString.optional(),
  displayName: NullableString.optional(),
  members: z.array(GroupMember).nullable().optional(),
});
export type GroupInput = z.infer<typeof GroupInput>;

export const PatchOperation = z.object({
  op: z.string(),
  path: NullableString.optional(),
  value: z.unknown().optional(),
});
export type PatchOperation = z.infer<typeof PatchOperation>;

export const PatchRequest = z.object({
  schemas: z.array(z.string()).nullable().optional(),
  Operations: z.array(PatchOperation),
});
export type PatchRequest = z.infer<typeof PatchRequest>;

const ResourceReference = z.object({
  value: z.string(),
  display: z.string().optional(),
  $ref: z.string().optional(),
});

const ResourceMetadata = z.object({
  resourceType: z.string(),
  created: z.string(),
  lastModified: z.string(),
  version: z.string(),
  location: z.string(),
});

export const UserResource = z.looseObject({
  ...user_attributes,
  schemas: z.tuple([z.literal(USER_SCHEMA_URI)]),
  id: z.string(),
  userName: z.string(),
  displayName: z.string().optional(),
  active: z.boolean(),
  groups: z.array(ResourceReference),
  meta: ResourceMetadata.extend({ resourceType: z.literal("User") }),
});
export type UserResource = z.infer<typeof UserResource>;

export const GroupResource = z.looseObject({
  schemas: z.tuple([z.literal(GROUP_SCHEMA_URI)]),
  id: z.string(),
  externalId: z.string().optional(),
  displayName: z.string(),
  members: z.array(ResourceReference),
  meta: ResourceMetadata.extend({ resourceType: z.literal("Group") }),
});
export type GroupResource = z.infer<typeof GroupResource>;
export type ScimResource = UserResource | GroupResource;

export function make_list_response_schema<S extends z.ZodType>(resource_schema: S) {
  return z.object({
    schemas: z.tuple([z.literal(LIST_RESPONSE_SCHEMA_URI)]),
    totalResults: z.number().int().nonnegative(),
    startIndex: z.number().int().positive(),
    itemsPerPage: z.number().int().nonnegative(),
    Resources: z.array(resource_schema),
  });
}

export const UserListResponse = make_list_response_schema(UserResource);
export type UserListResponse = z.infer<typeof UserListResponse>;
export const GroupListResponse = make_list_response_schema(GroupResource);
export type GroupListResponse = z.infer<typeof GroupListResponse>;

export const ScimError = z.object({
  schemas: z.tuple([z.literal(ERROR_SCHEMA_URI)]),
  status: z.string(),
  scimType: z.string().optional(),
  detail: z.string(),
});
export type ScimError = z.infer<typeof ScimError>;

const SupportedFeature = z.object({ supported: z.boolean() });
const BulkFeature = SupportedFeature.extend({
  maxOperations: z.number().int().nonnegative(),
  maxPayloadSize: z.number().int().nonnegative(),
});
const FilterFeature = SupportedFeature.extend({
  maxResults: z.number().int().nonnegative(),
});

export const ServiceProviderConfig = z.object({
  schemas: z.array(z.string()),
  documentationUri: z.string(),
  patch: SupportedFeature,
  bulk: BulkFeature,
  filter: FilterFeature,
  changePassword: SupportedFeature,
  sort: SupportedFeature,
  etag: SupportedFeature,
  authenticationSchemes: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      description: z.string(),
      specUri: z.string(),
      primary: z.boolean(),
    }),
  ),
});
export type ServiceProviderConfig = z.infer<typeof ServiceProviderConfig>;

const SubAttributeDefinition = z.object({
  name: z.string(),
  type: z.string(),
  multiValued: z.boolean(),
  required: z.boolean(),
  caseExact: z.boolean().optional(),
  mutability: z.string(),
  returned: z.string(),
  uniqueness: z.string().optional(),
});

const AttributeDefinition = SubAttributeDefinition.extend({
  subAttributes: z.array(SubAttributeDefinition).optional(),
});

export const SchemaDefinition = z.object({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  attributes: z.array(AttributeDefinition),
});
export type SchemaDefinition = z.infer<typeof SchemaDefinition>;
export const SchemaListResponse = make_list_response_schema(SchemaDefinition);
export type SchemaListResponse = z.infer<typeof SchemaListResponse>;

export const ResourceType = z.object({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  schema: z.string(),
});
export type ResourceType = z.infer<typeof ResourceType>;
export const ResourceTypeListResponse = make_list_response_schema(ResourceType);
export type ResourceTypeListResponse = z.infer<typeof ResourceTypeListResponse>;
