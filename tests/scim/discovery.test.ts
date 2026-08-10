import { describe, expect, it } from "vitest";
import type { ScimServerRecord } from "../../src/db/schema.ts";
import {
  get_service_provider_config,
  RESOURCE_TYPES,
  SCHEMA_DEFINITIONS,
} from "../../src/lib/scim/server/discovery.ts";
import {
  ENTERPRISE_USER_SCHEMA_URI,
  GROUP_SCHEMA_URI,
  RESOURCE_TYPE_SCHEMA_URI,
  SCHEMA_DEFINITION_URI,
  SERVICE_PROVIDER_CONFIG_SCHEMA_URI,
  USER_SCHEMA_URI,
} from "../../src/lib/scim/server/constants.ts";

const server = { auth_mode: "bearer" } as ScimServerRecord;

describe("RFC 7643/7644 discovery resources", () => {
  it("advertises every implemented optional protocol feature accurately", () => {
    const config = get_service_provider_config(server);
    expect(config.patch).toEqual({ supported: true });
    expect(config.bulk).toEqual({ supported: true, maxOperations: 100, maxPayloadSize: 1_048_576 });
    expect(config.filter).toEqual({ supported: true, maxResults: 100 });
    expect(config.sort).toEqual({ supported: true });
    expect(config.etag).toEqual({ supported: true });
    expect(config.changePassword).toEqual({ supported: true });
    expect(config.authenticationSchemes).toEqual([
      expect.objectContaining({ type: "oauthbearertoken", primary: true }),
    ]);
  });

  it("describes User, Group, and enterprise User schemas", () => {
    expect(SCHEMA_DEFINITIONS.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        USER_SCHEMA_URI,
        GROUP_SCHEMA_URI,
        ENTERPRISE_USER_SCHEMA_URI,
        SERVICE_PROVIDER_CONFIG_SCHEMA_URI,
        RESOURCE_TYPE_SCHEMA_URI,
        SCHEMA_DEFINITION_URI,
      ]),
    );
    expect(SCHEMA_DEFINITIONS).toHaveLength(6);
    const user = SCHEMA_DEFINITIONS.find(({ id }) => id === USER_SCHEMA_URI)!;
    expect(user.attributes.find(({ name }) => name === "userName")).toMatchObject({
      required: true,
      caseExact: false,
      uniqueness: "server",
    });
    expect(user.attributes.find(({ name }) => name === "password")).toMatchObject({
      mutability: "writeOnly",
      returned: "never",
    });
    expect(user.attributes.find(({ name }) => name === "groups")).toMatchObject({
      multiValued: true,
      mutability: "readOnly",
    });
    expect(user.attributes.find(({ name }) => name === "addresses")?.subAttributes?.map(({ name }) => name)).toEqual([
      "formatted",
      "streetAddress",
      "locality",
      "region",
      "postalCode",
      "country",
      "type",
      "primary",
    ]);
  });

  it("declares nested Group references and the optional enterprise extension", () => {
    const group = SCHEMA_DEFINITIONS.find(({ id }) => id === GROUP_SCHEMA_URI)!;
    const ref = group.attributes
      .find(({ name }) => name === "members")
      ?.subAttributes?.find(({ name }) => name === "$ref");
    expect(ref).toMatchObject({ type: "reference", referenceTypes: ["User", "Group"], mutability: "immutable" });
    expect(RESOURCE_TYPES.find(({ id }) => id === "User")?.schemaExtensions).toEqual([
      { schema: ENTERPRISE_USER_SCHEMA_URI, required: false },
    ]);
  });

  it("advertises HTTP Basic when that is the configured mode", () => {
    expect(get_service_provider_config({ auth_mode: "basic" } as ScimServerRecord).authenticationSchemes[0]?.type).toBe(
      "httpbasic",
    );
  });
});
