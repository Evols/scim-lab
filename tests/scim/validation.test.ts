import { describe, expect, it } from "vitest";
import { validate_json_body } from "../../src/lib/scim/api/body.ts";
import { json_response } from "../../src/lib/scim/api/response.ts";
import { GroupInput, PatchRequest, SearchRequest, UserInput, UserResource } from "../../src/lib/scim/schemas.ts";
import {
  GROUP_SCHEMA_URI,
  PATCH_REQUEST_SCHEMA_URI,
  SEARCH_REQUEST_SCHEMA_URI,
  USER_SCHEMA_URI,
} from "../../src/lib/scim/server/constants.ts";

async function error_payload(result: ReturnType<typeof validate_json_body>) {
  if (result.success) throw new Error("Expected body validation to fail.");
  return result.response.json() as Promise<{ detail: string; scimType: string; status: string }>;
}

describe("RFC request and response structure validation", () => {
  it("maps malformed JSON and non-object JSON to invalidSyntax", async () => {
    for (const body of ["{", "[]", "null", '"string"']) {
      const error = await error_payload(validate_json_body(body, UserInput));
      expect(error).toMatchObject({ status: "400", scimType: "invalidSyntax" });
    }
  });

  it("requires the core schema URI in User and Group representations", async () => {
    expect((await error_payload(validate_json_body(JSON.stringify({ userName: "ada" }), UserInput))).detail).toContain(
      "schemas",
    );
    expect(
      (await error_payload(validate_json_body(JSON.stringify({ displayName: "Team" }), GroupInput))).detail,
    ).toContain("schemas");
    expect(validate_json_body(JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "ada" }), UserInput).success).toBe(
      true,
    );
    expect(
      validate_json_body(JSON.stringify({ schemas: [GROUP_SCHEMA_URI], displayName: "Team" }), GroupInput).success,
    ).toBe(true);
  });

  it("rejects duplicate schema URIs", async () => {
    const error = await error_payload(
      validate_json_body(JSON.stringify({ schemas: [USER_SCHEMA_URI, USER_SCHEMA_URI], userName: "ada" }), UserInput),
    );
    expect(error.detail).toContain("unique");
  });

  it("maps invalid core attribute shapes to invalidValue", async () => {
    const error = await error_payload(
      validate_json_body(JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: 42 }), UserInput),
    );
    expect(error.scimType).toBe("invalidValue");
    expect(error.detail).toContain("userName");
  });

  it("rejects password writes when changePassword is advertised as unsupported", async () => {
    const error = await error_payload(
      validate_json_body(
        JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "ada", password: "secret" }),
        UserInput,
      ),
    );
    expect(error).toMatchObject({ scimType: "invalidValue", status: "400" });
    expect(error.detail).toContain("password");
  });

  it("requires every supplied extension value to be declared in schemas", async () => {
    const extension = "urn:example:params:scim:schemas:extension:Custom:2.0:User";
    const invalid = await error_payload(
      validate_json_body(
        JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "ada", [extension]: { badge: "1" } }),
        UserInput,
      ),
    );
    expect(invalid.detail).toContain(extension);
    const valid = validate_json_body(
      JSON.stringify({ schemas: [USER_SCHEMA_URI, extension], userName: "ada", [extension]: { badge: "1" } }),
      UserInput,
    );
    expect(valid.success).toBe(true);
    if (valid.success) expect(valid.data[extension]).toEqual({ badge: "1" });
  });

  it("drops unknown nested core fields while retaining extension objects", () => {
    const result = validate_json_body(
      JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "ada", name: { givenName: "Ada", vendorField: "drop" } }),
      UserInput,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toEqual({ givenName: "Ada" });
  });

  it("validates Group member values and resource types", async () => {
    for (const members of [[{ display: "Ada" }], [{ value: "1", type: "Device" }]]) {
      const error = await error_payload(
        validate_json_body(JSON.stringify({ schemas: [GROUP_SCHEMA_URI], displayName: "Team", members }), GroupInput),
      );
      expect(error.scimType).toBe("invalidValue");
    }
  });

  it("requires the PatchOp schema and at least one operation", async () => {
    expect(
      (
        await error_payload(
          validate_json_body(JSON.stringify({ Operations: [{ op: "add", path: "title", value: "x" }] }), PatchRequest),
        )
      ).detail,
    ).toContain("schemas");
    expect(
      (
        await error_payload(
          validate_json_body(JSON.stringify({ schemas: [PATCH_REQUEST_SCHEMA_URI], Operations: [] }), PatchRequest),
        )
      ).detail,
    ).toContain("Operations");
    expect(
      validate_json_body(
        JSON.stringify({ schemas: [PATCH_REQUEST_SCHEMA_URI], Operations: [{ op: "archive", path: "active" }] }),
        PatchRequest,
      ).success,
    ).toBe(true);
  });

  it("validates SearchRequest sort order and integer pagination", async () => {
    const valid = {
      schemas: [SEARCH_REQUEST_SCHEMA_URI],
      filter: "userName pr",
      sortOrder: "ascending",
      startIndex: 1,
      count: 10,
    };
    expect(validate_json_body(JSON.stringify(valid), SearchRequest).success).toBe(true);
    expect(
      (await error_payload(validate_json_body(JSON.stringify({ ...valid, sortOrder: "sideways" }), SearchRequest)))
        .scimType,
    ).toBe("invalidValue");
  });

  it("validates server-generated resources at the HTTP boundary", () => {
    expect(() =>
      json_response(
        {
          schemas: [USER_SCHEMA_URI],
          id: "1",
          userName: "ada",
          active: "yes" as unknown as boolean,
          groups: [],
          meta: {
            resourceType: "User",
            created: new Date().toISOString(),
            lastModified: new Date().toISOString(),
            version: 'W/"1"',
            location: "https://example.test/Users/1",
          },
        },
        UserResource,
      ),
    ).toThrow();
  });
});
