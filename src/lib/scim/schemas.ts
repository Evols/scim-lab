import * as z from "zod";
import { GROUP_SCHEMA, LIST_SCHEMA, USER_SCHEMA } from "./server/constants.ts";

const NullableString = z.string().nullable();
const NullableBoolean = z.boolean().nullable();

const NameSchema = z.looseObject({
  formatted: NullableString.optional(),
  familyName: NullableString.optional(),
  givenName: NullableString.optional(),
  middleName: NullableString.optional(),
  honorificPrefix: NullableString.optional(),
  honorificSuffix: NullableString.optional(),
});

const MultiValuedAttributeSchema = z.looseObject({
  value: NullableString.optional(),
  display: NullableString.optional(),
  type: NullableString.optional(),
  primary: NullableBoolean.optional(),
  $ref: NullableString.optional(),
});

const AddressSchema = z.looseObject({
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
  name: NameSchema.nullable().optional(),
  nickName: NullableString.optional(),
  profileUrl: NullableString.optional(),
  title: NullableString.optional(),
  userType: NullableString.optional(),
  preferredLanguage: NullableString.optional(),
  locale: NullableString.optional(),
  timezone: NullableString.optional(),
  emails: z.array(MultiValuedAttributeSchema).nullable().optional(),
  phoneNumbers: z.array(MultiValuedAttributeSchema).nullable().optional(),
  ims: z.array(MultiValuedAttributeSchema).nullable().optional(),
  photos: z.array(MultiValuedAttributeSchema).nullable().optional(),
  addresses: z.array(AddressSchema).nullable().optional(),
  entitlements: z.array(MultiValuedAttributeSchema).nullable().optional(),
  roles: z.array(MultiValuedAttributeSchema).nullable().optional(),
  x509Certificates: z.array(MultiValuedAttributeSchema).nullable().optional(),
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
export const UserDataSchema = z.object(user_data_attributes);
export type UserData = z.infer<typeof UserDataSchema>;

// Loose objects preserve extension URNs and vendor attributes. The known core
// attributes still receive runtime validation and useful inferred types.
export const UserWriteSchema = z.looseObject(user_attributes);
export type UserWriteInput = z.infer<typeof UserWriteSchema>;

export const GroupMemberSchema = z.looseObject({
  value: z.string(),
  display: NullableString.optional(),
  $ref: NullableString.optional(),
  type: NullableString.optional(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GroupWriteSchema = z.looseObject({
  schemas: z.array(z.string()).nullable().optional(),
  externalId: NullableString.optional(),
  displayName: NullableString.optional(),
  members: z.array(GroupMemberSchema).nullable().optional(),
});
export type GroupWriteInput = z.infer<typeof GroupWriteSchema>;

export const PatchOperationSchema = z.looseObject({
  op: z.string(),
  path: NullableString.optional(),
  value: z.unknown().optional(),
});
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export const PatchRequestSchema = z.looseObject({
  schemas: z.array(z.string()).nullable().optional(),
  Operations: z.array(PatchOperationSchema),
});
export type PatchRequest = z.infer<typeof PatchRequestSchema>;

const ResourceReferenceSchema = z.looseObject({
  value: z.string(),
  display: z.string().optional(),
  $ref: z.string().optional(),
});

const ResourceMetaSchema = z.object({
  resourceType: z.string(),
  created: z.string(),
  lastModified: z.string(),
  version: z.string(),
  location: z.string(),
});

export const UserResourceSchema = z.looseObject({
  ...user_attributes,
  schemas: z.tuple([z.literal(USER_SCHEMA)]),
  id: z.string(),
  userName: z.string(),
  displayName: z.string().optional(),
  active: z.boolean(),
  groups: z.array(ResourceReferenceSchema),
  meta: ResourceMetaSchema.extend({ resourceType: z.literal("User") }),
});
export type UserResource = z.infer<typeof UserResourceSchema>;

export const GroupResourceSchema = z.looseObject({
  schemas: z.tuple([z.literal(GROUP_SCHEMA)]),
  id: z.string(),
  externalId: z.string().optional(),
  displayName: z.string(),
  members: z.array(ResourceReferenceSchema),
  meta: ResourceMetaSchema.extend({ resourceType: z.literal("Group") }),
});
export type GroupResource = z.infer<typeof GroupResourceSchema>;
export type ScimResource = UserResource | GroupResource;

export function ListResponseSchema<S extends z.ZodType>(resourceSchema: S) {
  return z.object({
    schemas: z.tuple([z.literal(LIST_SCHEMA)]),
    totalResults: z.number().int().nonnegative(),
    startIndex: z.number().int().positive(),
    itemsPerPage: z.number().int().nonnegative(),
    Resources: z.array(resourceSchema),
  });
}

export const UserListResponseSchema = ListResponseSchema(UserResourceSchema);
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
export const GroupListResponseSchema = ListResponseSchema(GroupResourceSchema);
export type GroupListResponse = z.infer<typeof GroupListResponseSchema>;

export const ScimErrorSchema = z.object({
  schemas: z.tuple([z.literal("urn:ietf:params:scim:api:messages:2.0:Error")]),
  status: z.string(),
  scimType: z.string().optional(),
  detail: z.string(),
});

const SupportedSchema = z.looseObject({ supported: z.boolean() });
export const ServiceProviderConfigSchema = z.looseObject({
  schemas: z.array(z.string()),
  documentationUri: z.string(),
  patch: SupportedSchema,
  bulk: SupportedSchema,
  filter: SupportedSchema,
  changePassword: SupportedSchema,
  sort: SupportedSchema,
  etag: SupportedSchema,
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
export type ServiceProviderConfig = z.infer<typeof ServiceProviderConfigSchema>;

export const SchemaDocument = z.looseObject({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  attributes: z.array(z.looseObject({ name: z.string(), type: z.string() })),
});
export type SchemaDocument = z.infer<typeof SchemaDocument>;
export const SchemaDocumentListSchema = ListResponseSchema(SchemaDocument);

export const ResourceType = z.looseObject({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  schema: z.string(),
});
export type ResourceType = z.infer<typeof ResourceType>;
export const ResourceTypeListSchema = ListResponseSchema(ResourceType);
