import { purge_expired_records } from "../management/maintenance.ts";
import { APP_CONFIG } from "../config.ts";
import type { Database } from "../database.ts";
import { take_flash } from "./flash.ts";
import { create_anonymous_context, find_console_session, type ConsoleContext } from "./session.ts";

interface CookieValue {
  value: string;
}

export interface CookieStore {
  get(name: string): CookieValue | undefined;
  set(name: string, value: string, options: Record<string, unknown>): void;
  delete(name: string, options?: Record<string, unknown>): void;
}

export const SESSION_COOKIE_NAME = "scim_lab_session";
export const FLASH_COOKIE_NAME = "scim_lab_flash";

export function session_cookie_options(max_age = 30 * 86_400) {
  return {
    httpOnly: true,
    secure: APP_CONFIG.is_production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: max_age,
  };
}

export async function get_console_context(cookies: CookieStore, database: Database): Promise<ConsoleContext> {
  await purge_expired_records(database);

  const raw_token = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (raw_token) {
    const context = await find_console_session(raw_token, database);
    if (context) {
      return context;
    }
  }

  const context = await create_anonymous_context(database);
  cookies.set(SESSION_COOKIE_NAME, context.session_token!, session_cookie_options(37 * 86_400));
  return context;
}

export async function get_flash(
  cookies: CookieStore,
  user_id: string,
  database: Database,
): Promise<Record<string, unknown> | null> {
  const token = cookies.get(FLASH_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  cookies.delete(FLASH_COOKIE_NAME, { path: "/" });
  return take_flash(user_id, token, database);
}
