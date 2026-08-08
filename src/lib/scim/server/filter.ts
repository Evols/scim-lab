type DynamicObject = Record<string, unknown>;

function read_attribute(resource: object, attribute: string): unknown {
  const parts = attribute.split(".");
  const visit = (current: unknown, remaining: string[]): unknown => {
    // Dotted paths traverse every entry in multi-valued SCIM attributes.
    if (Array.isArray(current)) {
      return current
        .flatMap((entry) => {
          const value = visit(entry, remaining);
          return Array.isArray(value) ? value : [value];
        })
        .filter((value) => value !== undefined);
    }
    if (!remaining.length) {
      return current;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const record = current as DynamicObject;
    const part = remaining[0]!;
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === part.toLowerCase());
    return key ? visit(record[key], remaining.slice(1)) : undefined;
  };
  return visit(resource, parts);
}

function split_logical(filter: string, operator: "and" | "or"): string[] | null {
  let quoted = false;
  let depth = 0;
  // Only split top-level operators; quoted values and parenthesized expressions
  // are recursively evaluated as a unit.
  for (let index = 0; index <= filter.length - operator.length - 2; index += 1) {
    const character = filter[index];
    if (character === '"' && filter[index - 1] !== "\\") {
      quoted = !quoted;
    }
    if (quoted) {
      continue;
    }
    if (character === "(") {
      depth += 1;
    }
    if (character === ")") {
      depth -= 1;
    }
    const fragment = filter.slice(index, index + operator.length + 2).toLowerCase();
    if (depth === 0 && fragment === ` ${operator} `) {
      return [filter.slice(0, index), filter.slice(index + operator.length + 2)];
    }
  }
  return null;
}

function compare_filter(actual: unknown, operator: string, expected?: string): boolean {
  if (operator === "pr") {
    return actual !== undefined && actual !== null && actual !== "";
  }
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => {
    const normalized =
      typeof value === "object" && value && "value" in value
        ? String((value as { value: unknown }).value)
        : String(value ?? "");
    const left = normalized.toLocaleLowerCase();
    const right = String(expected ?? "").toLocaleLowerCase();
    if (operator === "eq") {
      return left === right;
    }
    if (operator === "ne") {
      return left !== right;
    }
    if (operator === "co") {
      return left.includes(right);
    }
    if (operator === "sw") {
      return left.startsWith(right);
    }
    if (operator === "ew") {
      return left.endsWith(right);
    }
    return false;
  });
}

export function matches_filter<T extends object>(resource: T, raw_filter: string): boolean {
  let filter = raw_filter.trim();
  if (filter.startsWith("(") && filter.endsWith(")")) {
    filter = filter.slice(1, -1).trim();
  }
  const or_parts = split_logical(filter, "or");
  if (or_parts) {
    return or_parts.some((part) => matches_filter(resource, part));
  }
  const and_parts = split_logical(filter, "and");
  if (and_parts) {
    return and_parts.every((part) => matches_filter(resource, part));
  }
  if (/^not\s+/i.test(filter)) {
    return !matches_filter(resource, filter.replace(/^not\s+/i, ""));
  }
  const comparison = filter.match(
    /^([\w.$:-]+)\s+(eq|ne|co|sw|ew|pr)(?:\s+(?:"((?:\\"|[^"])*)"|(true|false|null|-?\d+(?:\.\d+)?)))?$/i,
  );
  if (!comparison) {
    throw new Error("Unsupported or invalid SCIM filter.");
  }
  const [, attribute, operator, quoted, literal] = comparison;
  return compare_filter(read_attribute(resource, attribute!), operator!.toLowerCase(), quoted ?? literal);
}
