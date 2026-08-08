import * as z from "zod";
import { scim_error } from "./error.ts";

type BodyValidationResult<T> =
  { success: true; data: T } | { success: false; response: Response };

function invalid_structure(error: z.ZodError): Response {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  const reason = issue?.message ?? "The request body has an invalid structure.";
  return scim_error(
    400,
    `Request body is structurally invalid${path}: ${reason}`,
    "invalidValue",
  );
}

export function validate_json_body<S extends z.ZodType>(
  body: string,
  schema: S,
): BodyValidationResult<z.output<S>> {
  if (!body)
    return {
      success: false,
      response: scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      ),
    };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      success: false,
      response: scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      ),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {
      success: false,
      response: scim_error(
        400,
        "The request body must be a JSON object.",
        "invalidSyntax",
      ),
    };

  const result = schema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, response: invalid_structure(result.error) };
}
