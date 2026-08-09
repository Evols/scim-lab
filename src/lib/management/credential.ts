import { eq } from "drizzle-orm";
import { scim_servers } from "../../db/schema.ts";
import {
  decrypt_secret,
  encrypt_secret,
  generated_basic_username,
  generated_bearer_token,
  hash_secret,
  random_secret,
} from "../crypto.ts";
import type { Database } from "../database.ts";
import { get_server_for_user } from "./server.ts";

export interface ServerCredential {
  auth_mode: "bearer" | "basic";
  username: string | null;
  credential: string;
}

export async function read_server_credential(
  user_id: string,
  server_id: string,
  database: Database,
): Promise<ServerCredential> {
  const access = await get_server_for_user(user_id, server_id, database);
  if (!access) {
    throw new Error("Server not found.");
  }
  if (access.server.auth_mode === "basic") {
    if (!access.server.basic_password_encrypted) {
      throw new Error("This credential predates recoverable storage. Generate new Basic credentials in Settings.");
    }
    return {
      auth_mode: "basic",
      username: access.server.basic_username,
      credential: decrypt_secret(access.server.basic_password_encrypted),
    };
  }
  if (!access.server.bearer_token_encrypted) {
    throw new Error("This credential predates recoverable storage. Generate a new bearer token in Settings.");
  }
  return {
    auth_mode: "bearer",
    username: null,
    credential: decrypt_secret(access.server.bearer_token_encrypted),
  };
}

export async function rotate_server_auth(
  user_id: string,
  server_id: string,
  auth_mode: "bearer" | "basic",
  database: Database,
): Promise<void> {
  const access = await get_server_for_user(user_id, server_id, database);
  if (!access) {
    throw new Error("Server not found.");
  }
  if (auth_mode === "bearer") {
    const credential = generated_bearer_token();
    await database
      .update(scim_servers)
      .set({
        auth_mode,
        bearer_token_hash: hash_secret(credential),
        bearer_token_encrypted: encrypt_secret(credential),
        basic_username: null,
        basic_password_hash: null,
        basic_password_encrypted: null,
        credential_rotated_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(scim_servers.id, server_id));
    return;
  }
  const username = generated_basic_username(server_id);
  const credential = random_secret(24);
  await database
    .update(scim_servers)
    .set({
      auth_mode,
      bearer_token_hash: null,
      bearer_token_encrypted: null,
      basic_username: username,
      basic_password_hash: hash_secret(credential),
      basic_password_encrypted: encrypt_secret(credential),
      credential_rotated_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(scim_servers.id, server_id));
}
