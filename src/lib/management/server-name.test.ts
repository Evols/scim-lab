import { describe, expect, it } from "vitest";
import { generated_server_name } from "./server-name";

describe("server name generation", () => {
  it("generates a readable cloud-style name", () => {
    const values = [0, 1, 42];
    const bounds: number[] = [];

    const name = generated_server_name((max) => {
      bounds.push(max);
      return values.shift()!;
    });

    expect(name).toBe("agile-beacon-000042");
    expect(bounds).toEqual([26, 30, 1_000_000]);
  });

  it("uses lowercase words and a six-digit suffix", () => {
    expect(generated_server_name()).toMatch(/^[a-z]+-[a-z]+-\d{6}$/);
  });
});
