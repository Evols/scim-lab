import { describe, expect, it } from "vitest";
import { InvalidFilterError, matches_filter, read_attribute } from "../../src/lib/scim/server/filter.ts";
import { ENTERPRISE_USER_SCHEMA_URI, USER_SCHEMA_URI } from "../../src/lib/scim/server/constants.ts";

const user = {
  schemas: [USER_SCHEMA_URI, ENTERPRISE_USER_SCHEMA_URI],
  id: "CaseExact-ID",
  userName: "Ada@Example.com",
  userType: "Employee",
  title: "Engineer",
  active: true,
  score: 42,
  name: { familyName: "Lovelace", givenName: "Ada" },
  emails: [
    { value: "ada@home.test", type: "home" },
    { value: "ada@example.com", type: "work", primary: true },
  ],
  [ENTERPRISE_USER_SCHEMA_URI]: { employeeNumber: "A-100", manager: { value: "manager-1" } },
  meta: { lastModified: "2026-08-09T12:00:00Z", resourceType: "User" },
};

describe("RFC 7644 section 3.4.2.2 filtering", () => {
  it("treats attribute names and operators as case insensitive", () => {
    expect(matches_filter(user, 'Username Eq "ada@example.com"')).toBe(true);
    expect(matches_filter(user, 'NAME.FAMILYNAME co "LOVE"')).toBe(true);
  });

  it("implements every comparison operator", () => {
    expect(matches_filter(user, 'userName ne "grace"')).toBe(true);
    expect(matches_filter(user, 'userName sw "ada"')).toBe(true);
    expect(matches_filter(user, 'userName ew "example.com"')).toBe(true);
    expect(matches_filter(user, "title pr")).toBe(true);
    expect(matches_filter(user, "score gt 41")).toBe(true);
    expect(matches_filter(user, "score ge 42")).toBe(true);
    expect(matches_filter(user, "score lt 43")).toBe(true);
    expect(matches_filter(user, "score le 42")).toBe(true);
    expect(matches_filter(user, 'meta.lastModified gt "2026-01-01T00:00:00Z"')).toBe(true);
    expect(matches_filter(user, 'meta.lastModified gt "2026-08-09T13:00:00+02:00"')).toBe(true);
  });

  it("applies not, and, and or with RFC precedence", () => {
    expect(matches_filter(user, 'userType eq "Intern" or userType eq "Employee" and title pr')).toBe(true);
    expect(matches_filter(user, 'not (userType eq "Intern")')).toBe(true);
    expect(matches_filter(user, '(userType eq "Intern" or userType eq "Employee") and active eq true')).toBe(true);
  });

  it("requires a valuePath expression to match one multi-valued entry", () => {
    expect(matches_filter(user, 'emails[type eq "work" and value co "@example.com"]')).toBe(true);
    expect(matches_filter(user, 'emails[type eq "home" and value co "@example.com"]')).toBe(false);
  });

  it("supports core-qualified and extension-qualified attribute paths", () => {
    expect(matches_filter(user, `${USER_SCHEMA_URI}:userName eq "ada@example.com"`)).toBe(true);
    expect(matches_filter(user, `${ENTERPRISE_USER_SCHEMA_URI}:employeeNumber eq "a-100"`)).toBe(true);
    expect(read_attribute(user, `${ENTERPRISE_USER_SCHEMA_URI}:manager.value`)).toBe("manager-1");
  });

  it("supports the RFC root-query shorthand and complex value comparisons", () => {
    expect(matches_filter(user, "meta.resourceType eq User")).toBe(true);
    expect(matches_filter(user, 'emails co "@example.com"')).toBe(true);
  });

  it("uses caseExact comparison for identifiers", () => {
    expect(matches_filter(user, 'id eq "CaseExact-ID"')).toBe(true);
    expect(matches_filter(user, 'id eq "caseexact-id"')).toBe(false);
  });

  it("handles presence for empty and complex values", () => {
    expect(matches_filter({ empty: "", list: [], object: {}, nested: { value: "x" } }, "empty pr")).toBe(false);
    expect(matches_filter({ empty: "", list: [], object: {}, nested: { value: "x" } }, "list pr")).toBe(false);
    expect(matches_filter({ nested: { value: "x" } }, "nested pr")).toBe(true);
  });

  it.each([
    "",
    'userName regex "Ada"',
    "not userName pr",
    'emails[type eq "work"',
    "active gt false",
    "active co true",
    'meta.lastModified gt "not-a-date"',
  ])("rejects invalid filter %j with invalidFilter semantics", (filter) => {
    expect(() => matches_filter(user, filter)).toThrow(InvalidFilterError);
  });
});
