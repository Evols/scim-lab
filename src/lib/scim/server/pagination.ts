import { LIST_SCHEMA } from "./constants.ts";

export type ListResponse<T> = {
  schemas: [typeof LIST_SCHEMA];
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
  const parsed_start = Number.parseInt(params.start_index ?? "1", 10);
  const parsed_count = Number.parseInt(params.count ?? "100", 10);
  const start_index = Number.isFinite(parsed_start) ? Math.max(1, parsed_start) : 1;
  const requested_count = Number.isFinite(parsed_count) ? Math.max(0, parsed_count) : 100;
  // The service advertises maxResults=100, so every list endpoint enforces it.
  const page_count = Math.min(100, requested_count);
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: start_index,
    itemsPerPage: Math.min(page_count, Math.max(0, resources.length - start_index + 1)),
    Resources: resources.slice(start_index - 1, start_index - 1 + page_count),
  };
}
