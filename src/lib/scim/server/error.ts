export type ScimServiceErrorCode =
  | "filter_invalid"
  | "group_display_name_required"
  | "group_members_invalid"
  | "group_not_found"
  | "group_patch_path_unsupported"
  | "group_patch_removes_display_name"
  | "patch_mutability"
  | "patch_no_target"
  | "patch_operation_unsupported"
  | "patch_path_invalid"
  | "patch_value_invalid"
  | "query_invalid"
  | "resource_version_conflict"
  | "sort_invalid"
  | "user_limit_reached"
  | "user_name_not_unique"
  | "user_name_required"
  | "user_not_found"
  | "user_patch_removes_user_name";

export class ScimServiceError extends Error {
  constructor(
    public readonly code: ScimServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScimServiceError";
  }
}
