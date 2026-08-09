import { json_response } from "./response.ts";
import { ScimError } from "../schemas.ts";
import { ERROR_SCHEMA_URI } from "../server/constants.ts";

export function scim_error(status: number, detail: string, scim_type?: string): Response {
  return json_response(
    {
      schemas: [ERROR_SCHEMA_URI],
      status: String(status),
      ...(scim_type ? { scimType: scim_type } : {}),
      detail,
    },
    ScimError,
    status,
  );
}
