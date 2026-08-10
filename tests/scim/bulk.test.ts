import { describe, expect, it } from "vitest";
import { bulk_references, replace_bulk_references } from "../../src/lib/scim/api/bulk.ts";
import { BulkRequest, BulkResponse } from "../../src/lib/scim/schemas.ts";
import {
  BULK_REQUEST_SCHEMA_URI,
  BULK_RESPONSE_SCHEMA_URI,
  USER_SCHEMA_URI,
} from "../../src/lib/scim/server/constants.ts";

describe("RFC 7644 section 3.7 Bulk", () => {
  it("finds bulkId references recursively in paths and extension data", () => {
    expect([...bulk_references({ path: "/Users/bulkId:user", manager: { value: "bulkId:manager" } })]).toEqual([
      "user",
      "manager",
    ]);
  });

  it("replaces temporary identifiers recursively without changing unknown identifiers", () => {
    const value = { members: [{ value: "bulkId:user" }], manager: "bulkId:manager", untouched: "bulkId:later" };
    expect(
      replace_bulk_references(
        value,
        new Map([
          ["user", "u-1"],
          ["manager", "u-2"],
        ]),
      ),
    ).toEqual({ members: [{ value: "u-1" }], manager: "u-2", untouched: "bulkId:later" });
  });

  it("validates Bulk request method, path, data, failOnErrors, and schemas", () => {
    expect(
      BulkRequest.parse({
        schemas: [BULK_REQUEST_SCHEMA_URI],
        failOnErrors: 1,
        Operations: [
          { method: "POST", path: "/Users", bulkId: "user", data: { schemas: [USER_SCHEMA_URI], userName: "ada" } },
        ],
      }),
    ).toBeTruthy();
    expect(() =>
      BulkRequest.parse({ schemas: [BULK_REQUEST_SCHEMA_URI], Operations: [{ method: "GET", path: "/Users" }] }),
    ).toThrow();
    expect(() => BulkRequest.parse({ schemas: [BULK_REQUEST_SCHEMA_URI], Operations: [] })).toThrow();
  });

  it("uses string HTTP status values in Bulk responses", () => {
    expect(
      BulkResponse.parse({
        schemas: [BULK_RESPONSE_SCHEMA_URI],
        Operations: [
          { method: "POST", bulkId: "user", location: "https://example.test/Users/1", version: 'W/"1"', status: "201" },
        ],
      }),
    ).toBeTruthy();
    expect(() =>
      BulkResponse.parse({ schemas: [BULK_RESPONSE_SCHEMA_URI], Operations: [{ method: "POST", status: 201 }] }),
    ).toThrow();
  });
});
