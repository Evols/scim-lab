import { describe, expect, it } from "vitest";
import {
  decrypt_secret,
  encrypt_secret,
  hash_scim_password,
  hash_secret,
  safe_hash_equal,
  safe_scim_password_equal,
} from "../src/lib/crypto";

describe("credential protection", () => {
  it("verifies only the original high-entropy secret", () => {
    const stored_hash = hash_secret("secret-value");
    expect(safe_hash_equal(stored_hash, "secret-value")).toBe(true);
    expect(safe_hash_equal(stored_hash, "wrong-value")).toBe(false);
  });

  it("uses randomized authenticated encryption", () => {
    const first = encrypt_secret("secret-value");
    const second = encrypt_secret("secret-value");
    expect(first).not.toContain("secret-value");
    expect(first).not.toBe(second);
    expect(decrypt_secret(first)).toBe("secret-value");
    const tampered = `${first.slice(0, -1)}${first.endsWith("x") ? "y" : "x"}`;
    expect(() => decrypt_secret(tampered)).toThrow();
  });

  it("stores SCIM passwords as randomized scrypt hashes", () => {
    const first = hash_scim_password("pässword");
    const second = hash_scim_password("pässword");
    expect(first).not.toBe(second);
    expect(first).not.toContain("pässword");
    expect(safe_scim_password_equal(first, "pässword")).toBe(true);
    expect(safe_scim_password_equal(first, "pässword")).toBe(true);
    expect(safe_scim_password_equal(first, "wrong")).toBe(false);
    expect(safe_scim_password_equal("invalid", "pässword")).toBe(false);
  });
});
