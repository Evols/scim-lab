import { describe, expect, it } from "vitest";
import { create_bootstrap_challenge, local_return_path, valid_bootstrap_challenge } from "./bootstrap";

describe("browser bootstrap", () => {
  it("requires the same unexpired challenge in the form and browser cookie", () => {
    const now = Date.now();
    const challenge = create_bootstrap_challenge(now);
    expect(valid_bootstrap_challenge(challenge, challenge, now)).toBe(true);
    expect(valid_bootstrap_challenge(undefined, challenge, now)).toBe(false);
    expect(valid_bootstrap_challenge(challenge, create_bootstrap_challenge(now), now)).toBe(false);
    expect(valid_bootstrap_challenge(challenge + "x", challenge + "x", now)).toBe(false);
    expect(valid_bootstrap_challenge(challenge, challenge, now + 600_000)).toBe(false);
  });

  it("keeps bootstrap redirects on this origin", () => {
    expect(local_return_path("/?view=logs")).toBe("/?view=logs");
    for (const value of ["https://other.test", "//other.test", "/\\other.test", null]) {
      expect(local_return_path(value)).toBe("/");
    }
  });
});
