import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { APP_CONFIG } from "./config";

const CREDENTIAL_ENCRYPTION_KEY = createHash("sha256")
  .update("scim-lab:credential-encryption:v1\0")
  .update(APP_CONFIG.app_secret)
  .digest();

export function random_secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hash_secret(value: string): string {
  return createHmac("sha256", APP_CONFIG.app_secret).update(value).digest("hex");
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

export function hash_scim_password(value: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(value.normalize("NFC"), salt, 32);
  return `scrypt-v1.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

export function safe_scim_password_equal(stored_hash: string | null, candidate: string): boolean {
  if (!stored_hash) {
    return false;
  }
  const [version, encoded_salt, encoded_hash] = stored_hash.split(".");
  if (version !== "scrypt-v1" || !encoded_salt || !encoded_hash) {
    return false;
  }
  try {
    const expected = Buffer.from(encoded_hash, "base64url");
    const compared = scryptSync(candidate.normalize("NFC"), Buffer.from(encoded_salt, "base64url"), expected.length);
    return expected.length === compared.length && timingSafeEqual(expected, compared);
  } catch {
    return false;
  }
}

export function encrypt_secret(value: string): string {
  const initialization_vector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", CREDENTIAL_ENCRYPTION_KEY, initialization_vector);
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
  const parts = value.split(".");
  const [version, initialization_vector, authentication_tag, encrypted] = parts;
  if (
    parts.length !== 4 ||
    version !== "v1" ||
    !initialization_vector ||
    !authentication_tag ||
    encrypted === undefined ||
    Buffer.from(initialization_vector, "base64url").length !== 12 ||
    Buffer.from(authentication_tag, "base64url").length !== 16 ||
    [initialization_vector, authentication_tag, encrypted].some(
      (part) => Buffer.from(part, "base64url").toString("base64url") !== part,
    )
  ) {
    throw new Error("The stored credential has an unsupported encryption format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    CREDENTIAL_ENCRYPTION_KEY,
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
