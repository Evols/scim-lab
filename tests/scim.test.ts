import { describe, expect, it } from "vitest";
import { decrypt_secret, encrypt_secret, hash_secret, safe_hash_equal } from "../src/lib/crypto";
import { matches_filter, paginate } from "../src/lib/scim/scim.ts";

describe("SCIM filtering and pagination", () => {
  const resource = {
    userName: "Ada@Example.com",
    displayName: "Ada Lovelace",
    active: true,
    emails: [{ value: "ada@example.com" }],
  };

  it("supports core comparison and logical filters case-insensitively", () => {
    expect(matches_filter(resource, 'userName eq "ada@example.com"')).toBe(true);
    expect(matches_filter(resource, 'displayName sw "ada" and active eq true')).toBe(true);
    expect(matches_filter(resource, 'emails.value co "@example"')).toBe(true);
    expect(matches_filter(resource, 'not (displayName ew "hopper")')).toBe(true);
  });

  it("uses one-based pagination and caps pages at 100 resources", () => {
    const resources = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
    }));
    const page = paginate(resources, new URL("https://example.test/Users?startIndex=2&count=500"));
    expect(page.totalResults).toBe(120);
    expect(page.startIndex).toBe(2);
    expect(page.itemsPerPage).toBe(100);
    expect((page.Resources as Array<{ id: number }>)[0]?.id).toBe(2);
  });
});

describe("credential hashing", () => {
  it("verifies only the original high-entropy secret", () => {
    const stored_hash = hash_secret("secret-value");
    expect(safe_hash_equal(stored_hash, "secret-value")).toBe(true);
    expect(safe_hash_equal(stored_hash, "wrong-value")).toBe(false);
  });

  it("encrypts credentials with randomized authenticated encryption", () => {
    const first = encrypt_secret("secret-value");
    const second = encrypt_secret("secret-value");
    expect(first).not.toContain("secret-value");
    expect(first).not.toBe(second);
    expect(decrypt_secret(first)).toBe("secret-value");
    const tampered = `${first.slice(0, -1)}${first.endsWith("x") ? "y" : "x"}`;
    expect(() => decrypt_secret(tampered)).toThrow();
  });
});
