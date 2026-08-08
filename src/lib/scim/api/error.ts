import { json_response } from "./response.ts";
import { ScimErrorSchema } from "../schemas.ts";

const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export function scim_error(status: number, detail: string, scim_type?: string): Response {
  return json_response(
    {
      schemas: [ERROR_SCHEMA],
      status: String(status),
      ...(scim_type ? { scimType: scim_type } : {}),
      detail,
    },
    ScimErrorSchema,
    status,
  );
}
