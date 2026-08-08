import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { app_config } from "./config";

const credential_encryption_key = createHash("sha256")
  .update("scim-lab:credential-encryption:v1\0")
  .update(app_config.app_secret)
  .digest();

export function random_secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hash_secret(value: string): string {
  return createHmac("sha256", app_config.app_secret).update(value).digest("hex");
}

export function safe_hash_equal(stored_hash: string | null, candidate: string): boolean {
  if (!stored_hash) {
    return false;
  }
  const candidate_hash = hash_secret(candidate);
  const stored = Buffer.from(stored_hash, "hex");
  const compared = Buffer.from(candidate_hash, "hex");
  return stored.length === compared.length && timingSafeEqual(stored, compared);
}

export function encrypt_secret(value: string): string {
  const initialization_vector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credential_encryption_key, initialization_vector);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authentication_tag = cipher.getAuthTag();
  return [
    "v1",
    initialization_vector.toString("base64url"),
    authentication_tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decrypt_secret(value: string): string {
  const [version, initialization_vector, authentication_tag, encrypted] = value.split(".");
  if (version !== "v1" || !initialization_vector || !authentication_tag || encrypted === undefined) {
    throw new Error("The stored credential has an unsupported encryption format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    credential_encryption_key,
    Buffer.from(initialization_vector, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authentication_tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export function generated_bearer_token(): string {
  return `scim_${random_secret(32)}`;
}

export function generated_basic_username(server_id: string): string {
  return `scim_${server_id.replaceAll("-", "").slice(0, 10)}`;
}
