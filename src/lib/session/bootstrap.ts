import { decrypt_secret, encrypt_secret, random_secret } from "../crypto.ts";

export const BOOTSTRAP_COOKIE_NAME = "scim_lab_bootstrap";

export function create_bootstrap_challenge(now = Date.now()): string {
  return encrypt_secret(JSON.stringify({ purpose: "browser-bootstrap-v1", nonce: random_secret(), issued_at: now }));
}

export function valid_bootstrap_challenge(cookie: string | undefined, submitted: unknown, now = Date.now()): boolean {
  if (!cookie || typeof submitted !== "string" || cookie !== submitted || cookie.length > 1024) return false;
  try {
    const value = JSON.parse(decrypt_secret(cookie));
    return (
      value.purpose === "browser-bootstrap-v1" &&
      typeof value.nonce === "string" &&
      Number.isSafeInteger(value.issued_at) &&
      value.issued_at <= now + 60_000 &&
      now < value.issued_at + 10 * 60_000
    );
  } catch {
    return false;
  }
}

export function local_return_path(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/";
}
