const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";

export function json_response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, ...headers },
  });
}
