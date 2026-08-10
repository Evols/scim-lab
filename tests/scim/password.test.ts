import { describe, expect, it } from "vitest";
import { isolate_password_patch } from "../../src/lib/scim/server/password.ts";
import { USER_SCHEMA_URI } from "../../src/lib/scim/server/constants.ts";
import { ScimServiceError } from "../../src/lib/scim/server/error.ts";

const patch = (op: string, path?: string, value?: unknown) => ({ op, path, value });

describe("SCIM write-only password PATCH handling", () => {
  it("isolates direct and core-qualified password replacements", () => {
    expect(isolate_password_patch([patch("replace", "password", "first")])).toEqual({
      operations: [],
      password: "first",
    });
    expect(isolate_password_patch([patch("add", `${USER_SCHEMA_URI}:PASSWORD`, "second")])).toEqual({
      operations: [],
      password: "second",
    });
  });

  it("supports pathless, case-insensitive password values without dropping other attributes", () => {
    expect(isolate_password_patch([patch("replace", undefined, { Password: "new", displayName: "Ada" })])).toEqual({
      operations: [patch("replace", undefined, { displayName: "Ada" })],
      password: "new",
    });
  });

  it("uses the last password operation and treats remove, null, and empty strings as unassigned", () => {
    expect(
      isolate_password_patch([
        patch("replace", "password", "first"),
        patch("replace", "password", null),
        patch("add", "password", ""),
        patch("remove", "password"),
      ]),
    ).toEqual({ operations: [], password: null });
  });

  it.each([
    [patch("replace", "password", 42), "patch_value_invalid"],
    [patch("replace", "password"), "patch_value_invalid"],
    [patch("archive", "password", "secret"), "patch_operation_unsupported"],
  ])("rejects invalid password operations", (operation, code) => {
    expect(() => isolate_password_patch([operation])).toThrow(ScimServiceError);
    try {
      isolate_password_patch([operation]);
    } catch (error) {
      expect((error as ScimServiceError).code).toBe(code);
    }
  });
});
