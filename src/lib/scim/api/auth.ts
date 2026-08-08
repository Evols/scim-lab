import type { scim_server_record } from "../../../db/schema.ts";
import { safe_hash_equal } from "../../crypto.ts";

export type AuthenticationResult = {
  success: boolean;
  mode: string | null;
};

export function authenticate(
  server: scim_server_record,
  authorization: string | null,
): AuthenticationResult {
  if (server.auth_mode === "bearer") {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return {
      // Compare hashes in constant time; raw credentials are never persisted.
      success: Boolean(
        match && safe_hash_equal(server.bearer_token_hash, match[1]!),
      ),
      mode: match ? "bearer" : null,
    };
  }
  const match = authorization?.match(/^Basic\s+(.+)$/i);
  if (!match) return { success: false, mode: null };
  try {
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    // Split only on the first colon because passwords may contain colons.
    const separator = decoded.indexOf(":");
    const username = separator >= 0 ? decoded.slice(0, separator) : "";
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    return {
      success:
        username === server.basic_username &&
        safe_hash_equal(server.basic_password_hash, password),
      mode: "basic",
    };
  } catch {
    return { success: false, mode: "basic" };
  }
}
