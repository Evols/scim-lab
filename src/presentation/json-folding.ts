export interface JsonFoldRange {
  start: number;
  end: number;
  closing_token: "}" | "]";
}

interface OpenCollection {
  token: "{" | "[";
  line: number;
}

const matching_opening_token = { "}": "{", "]": "[" } as const;

export function find_json_fold_ranges(lines: string[]): Map<number, JsonFoldRange> {
  const ranges = new Map<number, JsonFoldRange>();
  const stack: OpenCollection[] = [];
  let in_string = false;
  let escaped = false;

  lines.forEach((line, line_index) => {
    for (const character of line) {
      if (in_string) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          in_string = false;
        }
        continue;
      }

      if (character === '"') {
        in_string = true;
      } else if (character === "{" || character === "[") {
        stack.push({ token: character, line: line_index });
      } else if (character === "}" || character === "]") {
        const opening = stack.at(-1);
        if (!opening || opening.token !== matching_opening_token[character]) {
          continue;
        }

        stack.pop();
        if (opening.line < line_index) {
          ranges.set(opening.line, {
            start: opening.line,
            end: line_index,
            closing_token: character,
          });
        }
      }
    }
  });

  return ranges;
}
