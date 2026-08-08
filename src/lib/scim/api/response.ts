import type * as z from "zod";

const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";

export function json_response<S extends z.ZodType>(
  value: z.input<S>,
  schema: S,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  // Parsing here makes the HTTP boundary validate server-generated payloads in
  // the same way request bodies are validated on the way in.
  const payload: z.output<S> = schema.parse(value);
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, ...headers },
  });
}
