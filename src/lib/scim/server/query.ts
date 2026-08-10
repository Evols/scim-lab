import { read_attribute } from "./filter.ts";
import { ScimServiceError } from "./error.ts";

type DynamicObject = Record<string, unknown>;

export type QueryOptions = {
  attributes?: string[];
  excluded_attributes?: string[];
  sort_by?: string | null;
  sort_order?: "ascending" | "descending" | null;
};

function split_attribute_list(value: string | null): string[] | undefined {
  const attributes = value
    ?.split(",")
    .map((attribute) => attribute.trim())
    .filter(Boolean);
  return attributes?.length ? attributes : undefined;
}

export function query_options(url: URL): QueryOptions {
  const order = url.searchParams.get("sortOrder")?.toLowerCase();
  if (order && order !== "ascending" && order !== "descending") {
    throw new ScimServiceError("sort_invalid", 'sortOrder must be either "ascending" or "descending".');
  }
  return {
    attributes: split_attribute_list(url.searchParams.get("attributes")),
    excluded_attributes: split_attribute_list(url.searchParams.get("excludedAttributes")),
    sort_by: url.searchParams.get("sortBy"),
    sort_order: order as QueryOptions["sort_order"],
  };
}

function sortable_value(resource: object, path: string): unknown {
  const value = read_attribute(resource, path);
  if (!Array.isArray(value)) return value;
  const primary = value.find(
    (entry) => entry && typeof entry === "object" && (entry as DynamicObject).primary === true,
  );
  const selected = primary ?? value[0];
  return selected && typeof selected === "object" && "value" in selected ? (selected as DynamicObject).value : selected;
}

function compare_sort_values(left: unknown, right: unknown, path: string): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const left_string = String(left);
  const right_string = String(right);
  if (/[.:](created|lastmodified)$/i.test(path)) {
    const left_date = Date.parse(left_string);
    const right_date = Date.parse(right_string);
    if (Number.isFinite(left_date) && Number.isFinite(right_date)) return left_date - right_date;
  }
  const attribute = path.split(/[.:]/).at(-1)?.toLowerCase();
  const case_exact = ["id", "externalid", "$ref", "schemas", "timezone", "x509certificates"].includes(attribute ?? "");
  return (case_exact ? left_string : left_string.toLocaleLowerCase()).localeCompare(
    case_exact ? right_string : right_string.toLocaleLowerCase(),
    "und",
  );
}

export function sort_resources<T extends object>(
  resources: T[],
  sort_by?: string | null,
  sort_order?: string | null,
): T[] {
  if (!sort_by) return resources;
  if (sort_order && !["ascending", "descending"].includes(sort_order.toLowerCase())) {
    throw new ScimServiceError("sort_invalid", 'sortOrder must be either "ascending" or "descending".');
  }
  const direction = sort_order?.toLowerCase() === "descending" ? -1 : 1;
  return resources
    .map((resource, index) => ({ resource, index }))
    .sort((left, right) => {
      const a = sortable_value(left.resource, sort_by);
      const b = sortable_value(right.resource, sort_by);
      if (a == null && b == null) return left.index - right.index;
      if (a == null) return direction;
      if (b == null) return -direction;
      const order = compare_sort_values(a, b, sort_by);
      return order === 0 ? left.index - right.index : order * direction;
    })
    .map(({ resource }) => resource);
}

function matching_key(record: DynamicObject, requested: string): string | undefined {
  return Object.keys(record).find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
}

function split_path(resource: DynamicObject, path: string): string[] {
  const schema_key = Object.keys(resource)
    .filter((key) => key.includes(":"))
    .sort((left, right) => right.length - left.length)
    .find((key) => path.toLowerCase().startsWith(`${key.toLowerCase()}:`));
  if (schema_key) return [schema_key, ...path.slice(schema_key.length + 1).split(".")];
  const core_marker = ":2.0:";
  const marker_index = path.toLowerCase().indexOf(core_marker);
  if (marker_index >= 0) {
    const attribute_start = path.indexOf(":", marker_index + core_marker.length);
    if (attribute_start >= 0) return path.slice(attribute_start + 1).split(".");
  }
  return path.split(".");
}

function select_path(source: DynamicObject, target: DynamicObject, path: string): void {
  const parts = split_path(source, path);
  let input: unknown = source;
  let output = target;
  for (let index = 0; index < parts.length; index += 1) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const key = matching_key(input as DynamicObject, parts[index]!);
    if (!key) return;
    const value = (input as DynamicObject)[key];
    if (index === parts.length - 1) {
      output[key] = value;
      return;
    }
    if (Array.isArray(value)) {
      const remainder = parts.slice(index + 1).join(".");
      output[key] = value.map((entry) => {
        const projected: DynamicObject = {};
        if (entry && typeof entry === "object") select_path(entry as DynamicObject, projected, remainder);
        return projected;
      });
      return;
    }
    if (!output[key] || typeof output[key] !== "object") output[key] = {};
    output = output[key] as DynamicObject;
    input = value;
  }
}

function delete_path(target: DynamicObject, path: string): void {
  const parts = split_path(target, path);
  let current: unknown = target;
  for (let index = 0; index < parts.length; index += 1) {
    if (Array.isArray(current)) {
      for (const entry of current)
        if (entry && typeof entry === "object") delete_path(entry as DynamicObject, parts.slice(index).join("."));
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as DynamicObject;
    const key = matching_key(record, parts[index]!);
    if (!key) return;
    if (index === parts.length - 1) delete record[key];
    else current = record[key];
  }
}

export function project_resource<T extends object>(
  resource: T,
  attributes?: string[],
  excluded_attributes?: string[],
): DynamicObject {
  if (attributes?.length && excluded_attributes?.length) {
    throw new ScimServiceError("query_invalid", "attributes and excludedAttributes cannot be used together.");
  }
  let result: DynamicObject;
  if (attributes?.length) {
    result = {};
    // schemas is required by RFC 7643 section 3 and id is returned=always.
    select_path(resource as DynamicObject, result, "schemas");
    select_path(resource as DynamicObject, result, "id");
    for (const path of attributes) select_path(resource as DynamicObject, result, path);
  } else {
    result = structuredClone(resource as DynamicObject);
    for (const path of excluded_attributes ?? []) {
      if (!["id", "schemas"].includes(path.toLowerCase())) delete_path(result, path);
    }
  }
  return result;
}

export function project_list<T extends object>(resources: T[], options: QueryOptions): DynamicObject[] {
  return resources.map((resource) => project_resource(resource, options.attributes, options.excluded_attributes));
}
