import { describe, expect, it } from "vitest";
import { validate_json_body } from "../src/lib/scim/api/body.ts";
import { json_response } from "../src/lib/scim/api/response.ts";
import {
  GroupWriteSchema,
  PatchRequestSchema,
  UserResourceSchema,
  UserWriteSchema,
} from "../src/lib/scim/schemas.ts";

async function error_payload(result: ReturnType<typeof validate_json_body>) {
  if (result.success) {
    throw new Error("Expected body validation to fail.");
  }
  return result.response.json() as Promise<{
    detail: string;
    scimType: string;
  }>;
}

describe("SCIM request structure validation", () => {
  it("maps malformed JSON to invalidSyntax", async () => {
    const result = validate_json_body("{", UserWriteSchema);
    const error = await error_payload(result);

    expect(error.scimType).toBe("invalidSyntax");
  });

  it("maps invalid core attribute shapes to invalidValue", async () => {
    const result = validate_json_body(
      JSON.stringify({ userName: 42 }),
      UserWriteSchema,
    );
    const error = await error_payload(result);

    expect(error.scimType).toBe("invalidValue");
    expect(error.detail).toContain("userName");
  });

  it("preserves unknown SCIM extensions", () => {
    const extension =
      "urn:example:params:scim:schemas:extension:Custom:2.0:User";
    const result = validate_json_body(
      JSON.stringify({
        userName: "ada@example.com",
        [extension]: { employeeNumber: "123" },
      }),
      UserWriteSchema,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[extension]).toEqual({ employeeNumber: "123" });
    }
  });

  it("requires group members to have a string value", async () => {
    const result = validate_json_body(
      JSON.stringify({ members: [{ display: "Ada" }] }),
      GroupWriteSchema,
    );
    const error = await error_payload(result);

    expect(error.scimType).toBe("invalidValue");
    expect(error.detail).toContain("members.0.value");
  });

  it("leaves supported-operation checks to the PATCH handler", () => {
    const result = validate_json_body(
      JSON.stringify({ Operations: [{ op: "archive", path: "active" }] }),
      PatchRequestSchema,
    );

    expect(result.success).toBe(true);
  });

  it("validates resources again at the outgoing HTTP boundary", () => {
    expect(() =>
      json_response(
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          id: "user-id",
          userName: "ada@example.com",
          // Simulate data corrupted outside TypeScript so runtime validation is
          // exercised in addition to the serializer's compile-time contract.
          active: "yes" as unknown as boolean,
          groups: [],
          meta: {
            resourceType: "User",
            created: new Date().toISOString(),
            lastModified: new Date().toISOString(),
            version: 'W/"1"',
            location: "https://example.test/Users/user-id",
          },
        },
        UserResourceSchema,
      ),
    ).toThrow();
  });
});
