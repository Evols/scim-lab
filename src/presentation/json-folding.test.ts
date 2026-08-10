import { describe, expect, it } from "vitest";
import { find_json_fold_ranges } from "./json-folding";

function formatted_lines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

describe("JSON folding ranges", () => {
  it("pairs nested objects and arrays with their closing lines", () => {
    const lines = formatted_lines({
      schemas: ["urn:example:User"],
      name: { givenName: "Ada", familyName: "Lovelace" },
    });
    const ranges = find_json_fold_ranges(lines);
    const schemas_line = lines.findIndex((line) => line.includes('"schemas"'));
    const name_line = lines.findIndex((line) => line.includes('"name"'));

    expect(ranges.get(0)).toEqual({ start: 0, end: lines.length - 1, closing_token: "}" });
    expect(ranges.get(schemas_line)).toMatchObject({ start: schemas_line, closing_token: "]" });
    expect(ranges.get(name_line)).toMatchObject({ start: name_line, closing_token: "}" });
  });

  it("does not offer folds for empty collections rendered on one line", () => {
    const lines = formatted_lines({ emptyObject: {}, emptyArray: [] });
    const ranges = find_json_fold_ranges(lines);

    expect(ranges.size).toBe(1);
    expect(ranges.has(lines.findIndex((line) => line.includes("emptyObject")))).toBe(false);
    expect(ranges.has(lines.findIndex((line) => line.includes("emptyArray")))).toBe(false);
  });

  it("ignores collection characters inside JSON strings, including escaped quotes", () => {
    const lines = formatted_lines({ value: 'text with { [ } ] and an escaped "quote"' });
    const ranges = find_json_fold_ranges(lines);

    expect([...ranges.values()]).toEqual([{ start: 0, end: lines.length - 1, closing_token: "}" }]);
  });
});
