import { ScimServiceError } from "../server/error.ts";
import { scim_error } from "./error.ts";

type ErrorMapping = {
  status: number;
  scim_type?: string;
};

const ERROR_MAPPINGS: Record<ScimServiceError["code"], ErrorMapping> = {
  filter_invalid: { status: 400, scim_type: "invalidFilter" },
  group_display_name_required: { status: 400, scim_type: "invalidValue" },
  group_members_invalid: { status: 400, scim_type: "invalidValue" },
  group_not_found: { status: 404 },
  group_patch_path_unsupported: { status: 400, scim_type: "invalidPath" },
  group_patch_removes_display_name: {
    status: 400,
    scim_type: "mutability",
  },
  patch_mutability: { status: 400, scim_type: "mutability" },
  patch_no_target: { status: 400, scim_type: "noTarget" },
  patch_operation_unsupported: { status: 400, scim_type: "invalidValue" },
  patch_path_invalid: { status: 400, scim_type: "invalidPath" },
  patch_value_invalid: { status: 400, scim_type: "invalidValue" },
  query_invalid: { status: 400, scim_type: "invalidValue" },
  resource_version_conflict: { status: 412 },
  sort_invalid: { status: 400, scim_type: "invalidValue" },
  user_limit_reached: { status: 409 },
  user_name_not_unique: { status: 409, scim_type: "uniqueness" },
  user_name_required: { status: 400, scim_type: "invalidValue" },
  user_not_found: { status: 404 },
  user_patch_removes_user_name: { status: 400, scim_type: "mutability" },
};

export function service_error_response(error: unknown): Response | null {
  if (!(error instanceof ScimServiceError)) {
    return null;
  }
  const mapping = ERROR_MAPPINGS[error.code];
  return scim_error(mapping.status, error.message, mapping.scim_type);
}
