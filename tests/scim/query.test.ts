import { describe, expect, it } from "vitest";
import { paginate } from "../../src/lib/scim/server/pagination.ts";
import { project_resource, sort_resources } from "../../src/lib/scim/server/query.ts";
import { LIST_RESPONSE_SCHEMA_URI, USER_SCHEMA_URI } from "../../src/lib/scim/server/constants.ts";

describe("RFC 7644 query controls", () => {
  it("uses one-based pagination, caps count, and reports the actual page size", () => {
    const resources = Array.from({ length: 120 }, (_, index) => ({ id: index + 1 }));
    const page = paginate(resources, { start_index: "2", count: "500" });
    expect(page).toMatchObject({
      schemas: [LIST_RESPONSE_SCHEMA_URI],
      totalResults: 120,
      startIndex: 2,
      itemsPerPage: 100,
    });
    expect(page.Resources[0]).toEqual({ id: 2 });
    expect(paginate(resources, { start_index: "200", count: "10" }).itemsPerPage).toBe(0);
  });

  it("interprets startIndex below one as one and negative count as zero", () => {
    expect(paginate([1, 2], { start_index: "0", count: "-1" })).toMatchObject({
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
  });

  it("sorts singular values case insensitively and keeps sorting stable", () => {
    const resources = [
      { id: "1", name: "zoe" },
      { id: "2", name: "Ada" },
      { id: "3", name: "ada" },
    ];
    expect(sort_resources(resources, "name", "ascending").map(({ id }) => id)).toEqual(["2", "3", "1"]);
    expect(sort_resources(resources, "name", "descending").map(({ id }) => id)).toEqual(["1", "2", "3"]);
  });

  it("sorts multi-values by primary then first and positions missing values per direction", () => {
    const resources = [
      { id: "missing" },
      { id: "first", emails: [{ value: "z@test" }, { value: "a@test" }] },
      { id: "primary", emails: [{ value: "z@test" }, { value: "b@test", primary: true }] },
    ];
    expect(sort_resources(resources, "emails", "ascending").map(({ id }) => id)).toEqual([
      "primary",
      "first",
      "missing",
    ]);
    expect(sort_resources(resources, "emails", "descending").map(({ id }) => id)).toEqual([
      "missing",
      "first",
      "primary",
    ]);
  });

  it("sorts DateTime attributes chronologically across offsets", () => {
    const resources = [
      { id: "later", meta: { lastModified: "2026-08-09T12:00:00Z" } },
      { id: "earlier", meta: { lastModified: "2026-08-09T13:00:00+02:00" } },
    ];
    expect(sort_resources(resources, "meta.lastModified").map(({ id }) => id)).toEqual(["earlier", "later"]);
  });

  it("projects selected attributes while always returning id", () => {
    const resource = {
      schemas: ["schema"],
      id: "1",
      userName: "ada",
      name: { givenName: "Ada", familyName: "Lovelace" },
      meta: { created: "today" },
    };
    expect(project_resource(resource, ["userName", "name.givenName"])).toEqual({
      schemas: ["schema"],
      id: "1",
      userName: "ada",
      name: { givenName: "Ada" },
    });
  });

  it("projects core-qualified attribute paths", () => {
    const resource = { schemas: [USER_SCHEMA_URI], id: "1", userName: "ada", title: "Engineer" };
    expect(project_resource(resource, [`${USER_SCHEMA_URI}:userName`])).toEqual({
      schemas: [USER_SCHEMA_URI],
      id: "1",
      userName: "ada",
    });
  });

  it("excludes default attributes but never excludes id", () => {
    const resource = { id: "1", userName: "ada", title: "Engineer" };
    expect(project_resource(resource, undefined, ["id", "title"])).toEqual({ id: "1", userName: "ada" });
  });

  it("rejects attributes and excludedAttributes used together", () => {
    expect(() => project_resource({ id: "1" }, ["id"], ["title"])).toThrow("cannot be used together");
  });
});
