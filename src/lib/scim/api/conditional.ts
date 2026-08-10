import * as z from "zod";
import { project_resource, type QueryOptions } from "../server/query.ts";
import { scim_error } from "./error.ts";
import { json_response } from "./response.ts";

type VersionedResource = { meta: { version: string; location: string } };

export function etag_matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => candidate.trim() === "*" || candidate.trim() === etag);
}

export function check_if_match(header: string | null, resource: VersionedResource): Response | null {
  return header && !etag_matches(header, resource.meta.version)
    ? scim_error(412, "The resource version does not match If-Match.")
    : null;
}

export function resource_response<S extends z.ZodType>(
  resource: VersionedResource & object,
  schema: S,
  request_headers: Headers,
  options: QueryOptions,
  status = 200,
): Response {
  schema.parse(resource);
  if (etag_matches(request_headers.get("if-none-match"), resource.meta.version)) {
    return new Response(null, { status: 304, headers: { etag: resource.meta.version } });
  }
  const projected = project_resource(resource, options.attributes, options.excluded_attributes);
  return json_response(projected, z.custom<Record<string, unknown>>(), status, {
    etag: resource.meta.version,
    location: resource.meta.location,
    "content-location": resource.meta.location,
  });
}
