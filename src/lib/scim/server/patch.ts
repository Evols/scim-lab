import type { PatchOperation } from "../schemas.ts";
import { ScimServiceError } from "./error.ts";
import { matches_filter } from "./filter.ts";
import { ENTERPRISE_USER_SCHEMA_URI, GROUP_SCHEMA_URI, USER_SCHEMA_URI } from "./constants.ts";

type DynamicObject = Record<string, unknown>;

type ParsedPath = { attribute: string; filter?: string; sub_attribute?: string };

function parse_path(path: string): ParsedPath {
  const bracket = path.indexOf("[");
  if (bracket >= 0) {
    let quoted = false;
    let closing = -1;
    for (let index = bracket + 1; index < path.length; index += 1) {
      if (path[index] === '"' && path[index - 1] !== "\\") quoted = !quoted;
      if (!quoted && path[index] === "]") {
        closing = index;
        break;
      }
    }
    const suffix = closing >= 0 ? path.slice(closing + 1) : "";
    if (closing < 0 || (suffix && !/^\.[A-Za-z][\w-]*$/.test(suffix))) {
      throw new ScimServiceError("patch_path_invalid", `Invalid PATCH path: ${path}.`);
    }
    return {
      attribute: path.slice(0, bracket),
      filter: path.slice(bracket + 1, closing),
      ...(suffix ? { sub_attribute: suffix.slice(1) } : {}),
    };
  }
  const last_colon = path.lastIndexOf(":");
  const dot = path.lastIndexOf(".");
  if (!path || path.includes("]") || path.includes("[") || !/^[A-Za-z$][A-Za-z0-9_$:.-]*$/.test(path)) {
    throw new ScimServiceError("patch_path_invalid", `Invalid PATCH path: ${path}.`);
  }
  return dot > last_colon ? { attribute: path.slice(0, dot), sub_attribute: path.slice(dot + 1) } : { attribute: path };
}

function matching_key(record: DynamicObject, requested: string): string | undefined {
  return Object.keys(record).find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
}

function is_read_only_top_level_attribute(requested: string): boolean {
  let attribute = requested.toLowerCase();
  for (const core of [USER_SCHEMA_URI, GROUP_SCHEMA_URI]) {
    if (attribute.startsWith(`${core.toLowerCase()}:`)) attribute = attribute.slice(core.length + 1);
  }
  return ["id", "meta", "schemas", "groups"].includes(attribute);
}

function resolve_container(
  resource: DynamicObject,
  requested: string,
): { container: DynamicObject; attribute: string } {
  const schema_key = Object.keys(resource)
    .filter((key) => key.includes(":"))
    .sort((left, right) => right.length - left.length)
    .find((key) => requested.toLowerCase().startsWith(`${key.toLowerCase()}:`));
  if (schema_key) {
    if (!resource[schema_key] || typeof resource[schema_key] !== "object" || Array.isArray(resource[schema_key]))
      resource[schema_key] = {};
    return { container: resource[schema_key] as DynamicObject, attribute: requested.slice(schema_key.length + 1) };
  }
  for (const core of [USER_SCHEMA_URI, GROUP_SCHEMA_URI]) {
    if (requested.toLowerCase().startsWith(`${core.toLowerCase()}:`))
      return { container: resource, attribute: requested.slice(core.length + 1) };
  }
  return { container: resource, attribute: requested };
}

function merge_object(target: DynamicObject, value: DynamicObject): void {
  for (const [requested_key, item] of Object.entries(value)) {
    const key = matching_key(target, requested_key) ?? requested_key;
    const current = target[key];
    if (
      current &&
      item &&
      typeof current === "object" &&
      typeof item === "object" &&
      !Array.isArray(current) &&
      !Array.isArray(item)
    ) {
      merge_object(current as DynamicObject, item as DynamicObject);
    } else if (Array.isArray(current) && Array.isArray(item)) target[key] = [...current, ...item];
    else target[key] = item;
  }
}

function apply_primary_invariant(resource: DynamicObject): void {
  for (const value of Object.values(resource)) {
    if (Array.isArray(value)) {
      let found_primary = false;
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const entry = value[index];
        if (!entry || typeof entry !== "object" || !("primary" in entry)) continue;
        const record = entry as DynamicObject;
        if (record.primary === true && !found_primary) found_primary = true;
        else if (record.primary === true) record.primary = false;
      }
      for (const entry of value)
        if (entry && typeof entry === "object") apply_primary_invariant(entry as DynamicObject);
    } else if (value && typeof value === "object") {
      apply_primary_invariant(value as DynamicObject);
    }
  }
}

function ensure_path(resource: DynamicObject, path: string): void {
  const parsed = parse_path(path);
  let top = parsed.attribute.toLowerCase();
  for (const core of [USER_SCHEMA_URI, GROUP_SCHEMA_URI]) {
    if (top.startsWith(`${core.toLowerCase()}:`)) top = top.slice(core.length + 1);
  }
  if (["id", "meta", "schemas", "groups"].includes(top)) {
    throw new ScimServiceError("patch_mutability", `Attribute ${top} is readOnly.`);
  }
  if ((top === "members" && parsed.sub_attribute) || /:manager\.displayname$/i.test(path)) {
    throw new ScimServiceError("patch_mutability", `A sub-attribute targeted by ${path} is immutable or readOnly.`);
  }
  if (top.includes(":")) return;
  const resource_type =
    resource.meta && typeof resource.meta === "object"
      ? String((resource.meta as DynamicObject).resourceType ?? "User")
      : "User";
  const allowed =
    resource_type === "Group"
      ? new Set(["externalid", "displayname", "members"])
      : new Set([
          "externalid",
          "username",
          "name",
          "displayname",
          "nickname",
          "profileurl",
          "title",
          "usertype",
          "preferredlanguage",
          "locale",
          "timezone",
          "active",
          "password",
          "emails",
          "phonenumbers",
          "ims",
          "photos",
          "addresses",
          "entitlements",
          "roles",
          "x509certificates",
        ]);
  if (!allowed.has(top)) throw new ScimServiceError("patch_path_invalid", `Unknown PATCH attribute path: ${path}.`);
  if (parsed.sub_attribute) {
    const sub_attributes: Record<string, Set<string>> = {
      name: new Set(["formatted", "familyname", "givenname", "middlename", "honorificprefix", "honorificsuffix"]),
      addresses: new Set([
        "formatted",
        "streetaddress",
        "locality",
        "region",
        "postalcode",
        "country",
        "type",
        "primary",
      ]),
      members: new Set(["value", "$ref", "type", "display"]),
    };
    const common = new Set(["value", "display", "type", "primary", "$ref"]);
    const multi_valued = new Set([
      "emails",
      "phonenumbers",
      "ims",
      "photos",
      "entitlements",
      "roles",
      "x509certificates",
    ]);
    const allowed_sub = sub_attributes[top] ?? (multi_valued.has(top) ? common : new Set<string>());
    if (!allowed_sub.has(parsed.sub_attribute.toLowerCase())) {
      throw new ScimServiceError("patch_path_invalid", `Unknown PATCH attribute path: ${path}.`);
    }
  }
}

export function merge_patch_value<T extends object>(
  target: T,
  path: string | undefined,
  value: unknown,
  operation: string,
): T {
  const resource = target as DynamicObject;
  if (!path) {
    if (operation === "remove") throw new ScimServiceError("patch_no_target", "A remove operation requires a path.");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ScimServiceError("patch_value_invalid", "A pathless PATCH value must be an object.");
    }
    // SCIM clients commonly echo readOnly attributes in a pathless operation.
    // RFC 7643 requires service providers to ignore those supplied values.
    const writable_value = Object.fromEntries(
      Object.entries(value as DynamicObject).filter(([key]) => !is_read_only_top_level_attribute(key)),
    ) as DynamicObject;
    for (const key of Object.keys(writable_value)) ensure_path(resource, key);
    const enterprise = writable_value[ENTERPRISE_USER_SCHEMA_URI];
    if (
      enterprise &&
      typeof enterprise === "object" &&
      !Array.isArray(enterprise) &&
      (enterprise as DynamicObject).manager &&
      typeof (enterprise as DynamicObject).manager === "object" &&
      "displayName" in ((enterprise as DynamicObject).manager as DynamicObject)
    ) {
      throw new ScimServiceError("patch_mutability", "manager.displayName is readOnly.");
    }
    if (operation === "add") merge_object(resource, writable_value);
    else {
      for (const [requested_key, item] of Object.entries(writable_value)) {
        const key = matching_key(resource, requested_key) ?? requested_key;
        const current = resource[key];
        if (
          current &&
          item &&
          typeof current === "object" &&
          typeof item === "object" &&
          !Array.isArray(current) &&
          !Array.isArray(item)
        ) {
          merge_object(current as DynamicObject, item as DynamicObject);
        } else resource[key] = item;
      }
    }
    apply_primary_invariant(resource);
    return target;
  }

  ensure_path(resource, path);
  const parsed = parse_path(path);
  const resolved = resolve_container(resource, parsed.attribute);
  const container = resolved.container;
  const key = matching_key(container, resolved.attribute) ?? resolved.attribute;
  if (!parsed.filter) {
    if (parsed.sub_attribute) {
      if (!container[key] || typeof container[key] !== "object" || Array.isArray(container[key])) {
        if (operation === "remove") return target;
        container[key] = {};
      }
      const complex = container[key] as DynamicObject;
      const sub_key = matching_key(complex, parsed.sub_attribute) ?? parsed.sub_attribute;
      if (operation === "remove") delete complex[sub_key];
      else complex[sub_key] = value;
      apply_primary_invariant(resource);
      return target;
    }
    if (operation === "remove") delete container[key];
    else if (operation === "add" && Array.isArray(container[key])) {
      container[key] = [...(container[key] as unknown[]), ...(Array.isArray(value) ? value : [value])];
    } else if (
      operation === "add" &&
      container[key] &&
      value &&
      typeof container[key] === "object" &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merge_object(container[key] as DynamicObject, value as DynamicObject);
    } else if (
      operation === "replace" &&
      container[key] &&
      value &&
      typeof container[key] === "object" &&
      typeof value === "object" &&
      !Array.isArray(container[key]) &&
      !Array.isArray(value)
    ) {
      merge_object(container[key] as DynamicObject, value as DynamicObject);
    } else container[key] = value;
    apply_primary_invariant(resource);
    return target;
  }

  try {
    matches_filter({}, parsed.filter);
  } catch {
    throw new ScimServiceError("patch_path_invalid", `Invalid value filter in PATCH path: ${path}.`);
  }
  const collection = container[key];
  if (!Array.isArray(collection))
    throw new ScimServiceError("patch_no_target", `PATCH path ${path} did not match a value.`);
  const matches = collection.map((entry) =>
    Boolean(entry && typeof entry === "object" && matches_filter(entry as object, parsed.filter!)),
  );
  if (!matches.some(Boolean) && operation !== "remove")
    throw new ScimServiceError("patch_no_target", `PATCH path ${path} did not match a value.`);
  if (operation === "remove" && !parsed.sub_attribute)
    container[key] = collection.filter((_, index) => !matches[index]);
  else {
    collection.forEach((entry, index) => {
      if (!matches[index] || !entry || typeof entry !== "object") return;
      if (parsed.sub_attribute) {
        const record = entry as DynamicObject;
        const sub_key = matching_key(record, parsed.sub_attribute) ?? parsed.sub_attribute;
        if (operation === "remove") delete record[sub_key];
        else record[sub_key] = value;
      } else if (operation === "replace") collection[index] = value;
      else if (operation === "add" && value && typeof value === "object" && !Array.isArray(value))
        merge_object(entry as DynamicObject, value as DynamicObject);
    });
  }
  apply_primary_invariant(resource);
  return target;
}

export function apply_patch<T extends object>(target: T, operations: PatchOperation[]): T {
  const resource = structuredClone(target);
  for (const operation of operations) {
    const op = operation.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op))
      throw new ScimServiceError("patch_operation_unsupported", `Unsupported PATCH operation: ${operation.op}.`);
    if (op !== "remove" && operation.value === undefined) {
      throw new ScimServiceError("patch_value_invalid", `${op} operations require a value.`);
    }
    merge_patch_value(resource, operation.path || undefined, operation.value, op);
  }
  return resource;
}
