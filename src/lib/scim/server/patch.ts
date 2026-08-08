type DynamicObject = Record<string, unknown>;

export function merge_patch_value<T extends object>(
  target: T,
  path: string | undefined,
  value: unknown,
  operation: string,
): T {
  // A pathless SCIM PATCH applies the fields in its object value to the resource.
  if (!path && value && typeof value === "object" && !Array.isArray(value)) {
    return operation === "remove"
      ? target
      : ({ ...target, ...(value as DynamicObject) } as T);
  }
  if (!path) {
    throw new Error("PATCH operation requires a path or object value.");
  }

  const parts = path.split(".");
  let current = target as DynamicObject;
  for (const part of parts.slice(0, -1)) {
    const key =
      Object.keys(current).find(
        (candidate) => candidate.toLowerCase() === part.toLowerCase(),
      ) ?? part;
    if (
      !current[key] ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key] as DynamicObject;
  }

  const last_part = parts.at(-1)!;
  const key =
    Object.keys(current).find(
      (candidate) => candidate.toLowerCase() === last_part.toLowerCase(),
    ) ?? last_part;
  if (operation === "remove") {
    delete current[key];
  } else current[key] = value;
  return target;
}
