import { LIST_RESPONSE_SCHEMA_URI } from "./constants.ts";

export type ListResponse<T> = {
  schemas: [typeof LIST_RESPONSE_SCHEMA_URI];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
};

export type PaginationParams = {
  start_index?: string | null;
  count?: string | null;
};

export type ListQuery = PaginationParams & {
  filter?: string | null;
  sort_by?: string | null;
  sort_order?: string | null;
};

function pagination_params(source: URL | PaginationParams): PaginationParams {
  return source instanceof URL
    ? {
        start_index: source.searchParams.get("startIndex"),
        count: source.searchParams.get("count"),
      }
    : source;
}

export function paginate<T>(resources: T[], source: URL | PaginationParams): ListResponse<T> {
  const params = pagination_params(source);
  const parsed_start = /^-?\d+$/.test(params.start_index ?? "1") ? Number(params.start_index ?? "1") : 1;
  const parsed_count = /^-?\d+$/.test(params.count ?? "100") ? Number(params.count ?? "100") : 100;
  const start_index = Number.isFinite(parsed_start) ? Math.max(1, parsed_start) : 1;
  const requested_count = Number.isFinite(parsed_count) ? Math.max(0, parsed_count) : 100;
  // The service advertises maxResults=100, so every list endpoint enforces it.
  const page_count = Math.min(100, requested_count);
  return {
    schemas: [LIST_RESPONSE_SCHEMA_URI],
    totalResults: resources.length,
    startIndex: start_index,
    itemsPerPage: Math.min(page_count, Math.max(0, resources.length - start_index + 1)),
    Resources: resources.slice(start_index - 1, start_index - 1 + page_count),
  };
}
