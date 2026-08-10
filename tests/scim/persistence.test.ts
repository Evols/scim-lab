import { describe, expect, it } from "vitest";
import { GroupInput, UserInput } from "../../src/lib/scim/schemas.ts";
import { clean_group_payload, clean_user_payload } from "../../src/lib/scim/server/resources.ts";
import { ENTERPRISE_USER_SCHEMA_URI, GROUP_SCHEMA_URI, USER_SCHEMA_URI } from "../../src/lib/scim/server/constants.ts";

describe("SCIM persistence normalization", () => {
  it("stores core flexible attributes and extensions but never computed attributes", () => {
    const input = UserInput.parse({
      schemas: [USER_SCHEMA_URI, ENTERPRISE_USER_SCHEMA_URI],
      id: "ignored",
      userName: "ada",
      name: { givenName: "Ada", middleName: null },
      emails: [
        { value: "first@test", primary: true },
        { value: "second@test", primary: true },
      ],
      groups: [{ value: "ignored" }],
      [ENTERPRISE_USER_SCHEMA_URI]: {
        employeeNumber: "100",
        manager: { value: "manager", displayName: "readOnly must be ignored" },
      },
    });
    expect(clean_user_payload(input)).toEqual({
      name: { givenName: "Ada" },
      emails: [
        { value: "first@test", primary: false },
        { value: "second@test", primary: true },
      ],
      [ENTERPRISE_USER_SCHEMA_URI]: { employeeNumber: "100", manager: { value: "manager" } },
    });
  });

  it("treats null, empty strings, empty arrays, and empty complex objects as unassigned", () => {
    const input = UserInput.parse({
      schemas: [USER_SCHEMA_URI],
      userName: "ada",
      nickName: null,
      title: "",
      emails: [],
      name: {},
    });
    expect(clean_user_payload(input)).toEqual({});
  });

  it("retains namespaced Group extensions only", () => {
    const extension = "urn:example:params:scim:schemas:extension:Team:2.0:Group";
    const input = GroupInput.parse({
      schemas: [GROUP_SCHEMA_URI, extension],
      displayName: "Team",
      vendorTopLevel: "ignored",
      [extension]: { category: "engineering" },
    });
    expect(clean_group_payload(input)).toEqual({ [extension]: { category: "engineering" } });
  });
});
