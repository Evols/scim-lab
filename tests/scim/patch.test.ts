import { describe, expect, it } from "vitest";
import { apply_patch, merge_patch_value } from "../../src/lib/scim/server/patch.ts";
import { ScimServiceError } from "../../src/lib/scim/server/error.ts";
import { ENTERPRISE_USER_SCHEMA_URI } from "../../src/lib/scim/server/constants.ts";

const patch = (op: string, path?: string, value?: unknown) => ({ op, path, value });

describe("RFC 7644 section 3.5.2 PATCH", () => {
  it("adds scalars, appends multi-valued attributes, and merges complex values", () => {
    const resource = { nickName: "Ada", name: { givenName: "Ada" }, emails: [{ value: "old@test" }] };
    merge_patch_value(resource, "nickName", "Enchantress", "add");
    merge_patch_value(resource, "name", { familyName: "Lovelace" }, "add");
    merge_patch_value(resource, "emails", [{ value: "new@test" }], "add");
    expect(resource).toEqual({
      nickName: "Enchantress",
      name: { givenName: "Ada", familyName: "Lovelace" },
      emails: [{ value: "old@test" }, { value: "new@test" }],
    });
  });

  it("supports pathless add and replace without deleting unrelated attributes", () => {
    const resource = { userName: "ada", title: "Engineer", emails: [{ value: "old@test" }] };
    const result = apply_patch(resource, [
      patch("add", undefined, { nickName: "Ada", emails: [{ value: "new@test" }] }),
      patch("replace", undefined, { title: "Countess" }),
    ]);
    expect(result).toMatchObject({ userName: "ada", nickName: "Ada", title: "Countess" });
    expect(result.emails).toHaveLength(2);
    expect(resource).toEqual({ userName: "ada", title: "Engineer", emails: [{ value: "old@test" }] });
  });

  it("ignores readOnly attributes echoed in a pathless operation", () => {
    const resource = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      id: "group-id",
      displayName: "Old name",
      meta: { resourceType: "Group", version: 'W/"1"' },
    };
    const result = apply_patch(resource, [
      patch("replace", undefined, {
        schemas: ["client-supplied-schema"],
        id: "client-supplied-id",
        displayName: "New name",
        meta: { resourceType: "User", version: 'W/"999"' },
      }),
    ]);
    expect(result).toEqual({ ...resource, displayName: "New name" });
  });

  it("removes all or filtered multi-values", () => {
    const resource = {
      emails: [
        { type: "home", value: "a@home" },
        { type: "work", value: "a@work" },
      ],
    };
    expect(apply_patch(resource, [patch("remove", 'emails[type eq "work"]')]).emails).toEqual([
      { type: "home", value: "a@home" },
    ]);
    expect(apply_patch(resource, [patch("remove", "emails")])).not.toHaveProperty("emails");
  });

  it("replaces a filtered record or one selected sub-attribute", () => {
    const resource = {
      addresses: [
        { type: "work", streetAddress: "Old" },
        { type: "home", streetAddress: "Home" },
      ],
    };
    expect(
      apply_patch(resource, [patch("replace", 'addresses[type eq "work"].streetAddress', "New")]).addresses[0],
    ).toEqual({ type: "work", streetAddress: "New" });
    expect(
      apply_patch(resource, [patch("replace", 'addresses[type eq "home"]', { type: "home", formatted: "New home" })])
        .addresses[1],
    ).toEqual({ type: "home", formatted: "New home" });
  });

  it("resets other primary values when a primary value is set", () => {
    const result = apply_patch(
      {
        emails: [
          { value: "one", primary: true },
          { value: "two", primary: false },
        ],
      },
      [patch("replace", 'emails[value eq "two"].primary', true)],
    );
    expect(result.emails).toEqual([
      { value: "one", primary: false },
      { value: "two", primary: true },
    ]);
  });

  it("supports qualified enterprise extension paths", () => {
    const resource = { [ENTERPRISE_USER_SCHEMA_URI]: { employeeNumber: "1", manager: { value: "old" } } };
    const result = apply_patch(resource, [patch("replace", `${ENTERPRISE_USER_SCHEMA_URI}:manager.value`, "new")]);
    expect(result[ENTERPRISE_USER_SCHEMA_URI].manager.value).toBe("new");
  });

  it.each([
    [patch("remove"), "patch_no_target"],
    [patch("replace", 'emails[type eq "missing"].value', "x"), "patch_no_target"],
    [patch("replace", "meta.created", "x"), "patch_mutability"],
    [patch("replace", "id", "x"), "patch_mutability"],
    [patch("remove", "groups"), "patch_mutability"],
    [patch("replace", 'members[value eq "x"].display', "X"), "patch_mutability"],
    [patch("archive", "active", false), "patch_operation_unsupported"],
    [patch("replace", "active"), "patch_value_invalid"],
    [patch("replace", "unknownAttribute", "x"), "patch_path_invalid"],
    [patch("replace", "name.unknownSubAttribute", "x"), "patch_path_invalid"],
  ])("returns the RFC error category for invalid operations", (operation, code) => {
    try {
      apply_patch({ emails: [], members: [] }, [operation]);
      throw new Error("Expected PATCH to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ScimServiceError);
      expect((error as ScimServiceError).code).toBe(code);
    }
  });
});
