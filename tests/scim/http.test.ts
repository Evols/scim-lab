import { describe, expect, it } from "vitest";
import { check_if_match, etag_matches, resource_response } from "../../src/lib/scim/api/conditional.ts";
import { scim_error } from "../../src/lib/scim/api/error.ts";
import { UserResource } from "../../src/lib/scim/schemas.ts";
import { USER_SCHEMA_URI } from "../../src/lib/scim/server/constants.ts";

const resource = {
  schemas: [USER_SCHEMA_URI],
  id: "1",
  userName: "ada",
  active: true,
  groups: [],
  meta: {
    resourceType: "User" as const,
    created: "2026-01-01T00:00:00Z",
    lastModified: "2026-01-01T00:00:00Z",
    version: 'W/"7"',
    location: "https://example.test/Users/1",
  },
};

describe("SCIM HTTP semantics", () => {
  it("uses application/scim+json for success and error payloads", () => {
    expect(resource_response(resource, UserResource, new Headers(), {}).headers.get("content-type")).toBe(
      "application/scim+json; charset=utf-8",
    );
    expect(scim_error(400, "bad", "invalidValue").headers.get("content-type")).toBe(
      "application/scim+json; charset=utf-8",
    );
  });

  it("returns ETag and Location for versioned resources", () => {
    const response = resource_response(resource, UserResource, new Headers(), {});
    expect(response.headers.get("etag")).toBe('W/"7"');
    expect(response.headers.get("location")).toBe("https://example.test/Users/1");
    expect(response.headers.get("content-location")).toBe("https://example.test/Users/1");
  });

  it("implements If-None-Match including lists and wildcard", () => {
    expect(etag_matches('W/"1", W/"7"', 'W/"7"')).toBe(true);
    expect(etag_matches("*", 'W/"7"')).toBe(true);
    expect(resource_response(resource, UserResource, new Headers({ "if-none-match": 'W/"7"' }), {}).status).toBe(304);
  });

  it("returns 412 when If-Match does not match", async () => {
    expect(check_if_match('W/"7"', resource)).toBeNull();
    const response = check_if_match('W/"6"', resource)!;
    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "412",
    });
  });

  it("projects conditional GET response bodies after validating the full resource", async () => {
    const response = resource_response(resource, UserResource, new Headers(), { attributes: ["userName"] });
    expect(await response.json()).toEqual({ schemas: [USER_SCHEMA_URI], id: "1", userName: "ada" });
  });
});
