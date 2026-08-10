import type { PatchOperation } from "../schemas.ts";
import { USER_SCHEMA_URI } from "./constants.ts";
import { ScimServiceError } from "./error.ts";

export interface PasswordPatch {
  operations: PatchOperation[];
  password: string | null | undefined;
}

function is_password_path(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === "password" || normalized === `${USER_SCHEMA_URI.toLowerCase()}:password`;
}

function password_value(value: unknown): string | null {
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new ScimServiceError("patch_value_invalid", "password must be a string or null.");
  }
  return value;
}

export function isolate_password_patch(operations: PatchOperation[]): PasswordPatch {
  const remaining: PatchOperation[] = [];
  let password: string | null | undefined;

  for (const operation of operations) {
    const op = operation.op.toLowerCase();
    if (!operation.path && operation.value && typeof operation.value === "object" && !Array.isArray(operation.value)) {
      const value = { ...(operation.value as Record<string, unknown>) };
      const key = Object.keys(value).find((candidate) => candidate.toLowerCase() === "password");
      if (key) {
        if (!["add", "replace"].includes(op)) {
          remaining.push(operation);
          continue;
        }
        password = password_value(value[key]);
        delete value[key];
        remaining.push({ ...operation, value });
        continue;
      }
    }

    if (!operation.path || !is_password_path(operation.path)) {
      remaining.push(operation);
      continue;
    }
    if (!["add", "replace", "remove"].includes(op)) {
      throw new ScimServiceError("patch_operation_unsupported", `Unsupported PATCH operation: ${operation.op}.`);
    }
    if (op === "remove") {
      password = null;
    } else {
      if (operation.value === undefined) {
        throw new ScimServiceError("patch_value_invalid", `${op} operations require a value.`);
      }
      password = password_value(operation.value);
    }
  }

  return { operations: remaining, password };
}
