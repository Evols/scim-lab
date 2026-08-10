type DynamicObject = Record<string, unknown>;

type ComparisonOperator = "eq" | "ne" | "co" | "sw" | "ew" | "pr" | "gt" | "ge" | "lt" | "le";
type FilterNode =
  | { type: "comparison"; path: string; operator: ComparisonOperator; value?: unknown }
  | { type: "valuePath"; path: string; filter: FilterNode }
  | { type: "not"; filter: FilterNode }
  | { type: "and" | "or"; left: FilterNode; right: FilterNode };

type Token = { type: "word"; value: string } | { type: "value"; value: unknown } | { type: "(" | ")" | "[" | "]" };

export class InvalidFilterError extends Error {
  constructor(message = "The supplied SCIM filter is invalid.") {
    super(message);
    this.name = "InvalidFilterError";
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (["(", ")", "[", "]"].includes(character)) {
      tokens.push({ type: character as "(" | ")" | "[" | "]" });
      index += 1;
      continue;
    }
    if (character === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        const next = source[end]!;
        if (!escaped && next === '"') break;
        escaped = !escaped && next === "\\";
        if (next !== "\\") escaped = false;
      }
      if (end >= source.length) throw new InvalidFilterError("The filter contains an unterminated string.");
      try {
        tokens.push({ type: "value", value: JSON.parse(source.slice(index, end + 1)) });
      } catch {
        throw new InvalidFilterError("The filter contains an invalid JSON string.");
      }
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < source.length && !/[\s()[\]]/.test(source[end]!)) end += 1;
    const word = source.slice(index, end);
    if (/^(true|false|null)$/i.test(word)) {
      tokens.push({ type: "value", value: word.toLowerCase() === "null" ? null : word.toLowerCase() === "true" });
    } else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(word)) {
      tokens.push({ type: "value", value: Number(word) });
    } else {
      tokens.push({ type: "word", value: word });
    }
    index = end;
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FilterNode {
    if (!this.tokens.length) throw new InvalidFilterError("A filter expression is required.");
    const node = this.parse_or();
    if (this.peek()) throw new InvalidFilterError("The filter contains an unexpected token.");
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private take(): Token {
    const token = this.tokens[this.index++];
    if (!token) throw new InvalidFilterError("The filter ended unexpectedly.");
    return token;
  }

  private word(value?: string): string | null {
    const token = this.peek();
    if (token?.type !== "word" || (value && token.value.toLowerCase() !== value)) return null;
    this.index += 1;
    return token.value;
  }

  private symbol(type: "(" | ")" | "[" | "]"): boolean {
    if (this.peek()?.type !== type) return false;
    this.index += 1;
    return true;
  }

  private parse_or(): FilterNode {
    let node = this.parse_and();
    while (this.word("or")) node = { type: "or", left: node, right: this.parse_and() };
    return node;
  }

  private parse_and(): FilterNode {
    let node = this.parse_not();
    while (this.word("and")) node = { type: "and", left: node, right: this.parse_not() };
    return node;
  }

  private parse_not(): FilterNode {
    if (this.word("not")) {
      if (!this.symbol("(")) throw new InvalidFilterError('The "not" operator must be followed by parentheses.');
      const filter = this.parse_or();
      if (!this.symbol(")")) throw new InvalidFilterError("The filter has unbalanced parentheses.");
      return { type: "not", filter };
    }
    if (this.symbol("(")) {
      const node = this.parse_or();
      if (!this.symbol(")")) throw new InvalidFilterError("The filter has unbalanced parentheses.");
      return node;
    }
    return this.parse_attribute();
  }

  private parse_attribute(): FilterNode {
    const path = this.word();
    if (!path) throw new InvalidFilterError("An attribute path was expected.");
    if (this.symbol("[")) {
      const filter = this.parse_or();
      if (!this.symbol("]")) throw new InvalidFilterError("The value path has an unbalanced bracket.");
      return { type: "valuePath", path, filter };
    }
    const raw_operator = this.word()?.toLowerCase();
    const operators = ["eq", "ne", "co", "sw", "ew", "pr", "gt", "ge", "lt", "le"];
    if (!raw_operator || !operators.includes(raw_operator)) {
      throw new InvalidFilterError(`The filter operator ${raw_operator ?? "is missing"} is not supported.`);
    }
    const operator = raw_operator as ComparisonOperator;
    if (operator === "pr") return { type: "comparison", path, operator };
    const value = this.take();
    if (value.type !== "value" && value.type !== "word") {
      throw new InvalidFilterError("A JSON comparison value was expected.");
    }
    return { type: "comparison", path, operator, value: value.value };
  }
}

function matching_key(record: DynamicObject, requested: string): string | undefined {
  return Object.keys(record).find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
}

function path_parts(resource: DynamicObject, path: string): string[] {
  const lower_path = path.toLowerCase();
  const schema_key = Object.keys(resource)
    .filter((key) => key.includes(":"))
    .sort((left, right) => right.length - left.length)
    .find((key) => lower_path.startsWith(`${key.toLowerCase()}:`));
  if (schema_key) return [schema_key, ...path.slice(schema_key.length + 1).split(".")];

  const core_marker = ":2.0:";
  const marker_index = lower_path.indexOf(core_marker);
  if (marker_index >= 0) {
    const attribute_start = path.indexOf(":", marker_index + core_marker.length);
    if (attribute_start >= 0) return path.slice(attribute_start + 1).split(".");
  }
  return path.split(".");
}

export function read_attribute(resource: unknown, path: string): unknown {
  if (!resource || typeof resource !== "object") return undefined;
  const parts = path_parts(resource as DynamicObject, path);
  const visit = (current: unknown, remaining: string[]): unknown => {
    if (Array.isArray(current)) {
      return current
        .flatMap((entry) => {
          const value = visit(entry, remaining);
          return Array.isArray(value) ? value : [value];
        })
        .filter((value) => value !== undefined);
    }
    if (!remaining.length) return current;
    if (!current || typeof current !== "object") return undefined;
    const record = current as DynamicObject;
    const key = matching_key(record, remaining[0]!);
    return key ? visit(record[key], remaining.slice(1)) : undefined;
  };
  return visit(resource, parts);
}

function present(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some(present);
  if (typeof value === "object") return Object.values(value as DynamicObject).some(present);
  return true;
}

function case_exact(path: string): boolean {
  const attribute = path.split(/[.:]/).at(-1)?.toLowerCase();
  return ["id", "externalid", "$ref", "schemas", "timezone", "x509certificates"].includes(attribute ?? "");
}

function ordered_compare(actual: unknown, expected: unknown, path: string): number {
  if (typeof actual === "boolean" || typeof expected === "boolean" || actual == null || expected == null) {
    throw new InvalidFilterError("Ordering operators cannot be used with boolean, binary, or null values.");
  }
  if (typeof actual === "number" && typeof expected === "number") return actual - expected;
  const left = String(actual);
  const right = String(expected);
  if (/[.:](created|lastmodified)$/i.test(path)) {
    const left_date = Date.parse(left);
    const right_date = Date.parse(right);
    if (!Number.isFinite(left_date) || !Number.isFinite(right_date)) {
      throw new InvalidFilterError("A DateTime comparison requires valid RFC 3339 values.");
    }
    return left_date - right_date;
  }
  if ((typeof actual === "number") !== (typeof expected === "number")) {
    throw new InvalidFilterError("An ordered numeric comparison requires a numeric value.");
  }
  return (case_exact(path) ? left : left.toLocaleLowerCase()).localeCompare(
    case_exact(path) ? right : right.toLocaleLowerCase(),
    "und",
  );
}

function compare_one(actual: unknown, operator: ComparisonOperator, expected: unknown, path: string): boolean {
  if (actual && typeof actual === "object" && !Array.isArray(actual) && "value" in actual) {
    actual = (actual as DynamicObject).value;
  }
  if (["co", "sw", "ew"].includes(operator) && (typeof actual !== "string" || typeof expected !== "string")) {
    throw new InvalidFilterError(`${operator} can only be used with string attributes.`);
  }
  const left = typeof actual === "string" && !case_exact(path) ? actual.toLocaleLowerCase() : actual;
  const right = typeof expected === "string" && !case_exact(path) ? expected.toLocaleLowerCase() : expected;
  if (operator === "eq") return left === right;
  if (operator === "ne") return left !== right;
  if (operator === "co") return (left as string).includes(right as string);
  if (operator === "sw") return (left as string).startsWith(right as string);
  if (operator === "ew") return (left as string).endsWith(right as string);
  const order = ordered_compare(actual, expected, path);
  if (operator === "gt") return order > 0;
  if (operator === "ge") return order >= 0;
  if (operator === "lt") return order < 0;
  return order <= 0;
}

function evaluate(node: FilterNode, resource: unknown): boolean {
  switch (node.type) {
    case "and":
      return evaluate(node.left, resource) && evaluate(node.right, resource);
    case "or":
      return evaluate(node.left, resource) || evaluate(node.right, resource);
    case "not":
      return !evaluate(node.filter, resource);
    case "valuePath": {
      const values = read_attribute(resource, node.path);
      return (Array.isArray(values) ? values : []).some((entry) => evaluate(node.filter, entry));
    }
    case "comparison": {
      const actual = read_attribute(resource, node.path);
      if (node.operator === "pr") return present(actual);
      const values = Array.isArray(actual) ? actual : [actual];
      return values.some((value) => value !== undefined && compare_one(value, node.operator, node.value, node.path));
    }
  }
}

export function matches_filter<T extends object>(resource: T, raw_filter: string): boolean {
  return evaluate(new Parser(tokenize(raw_filter.trim())).parse(), resource);
}
