import { APP_CONFIG } from "../config.ts";
import type { Database } from "../database.ts";
import { take_flash } from "./flash.ts";
import { find_console_session, SESSION_MAX_AGE_SECONDS, type ConsoleContext } from "./session.ts";
import {
  ANONYMOUS_COOKIE_PREFIX,
  ANONYMOUS_LIFETIME_DAYS,
  anonymous_cookie,
  create_provisional_workspace,
  find_anonymous_workspace,
  materialize_workspace,
  provisional_records,
  read_anonymous_cookie,
} from "./anonymous.ts";

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

export function session_cookie_options(max_age = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: APP_CONFIG.is_production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: max_age,
  };
}

export async function find_console_context(cookies: CookieStore, database: Database): Promise<ConsoleContext | null> {
  const raw_token = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (raw_token) {
    if (raw_token.startsWith(ANONYMOUS_COOKIE_PREFIX)) {
      const workspace = read_anonymous_cookie(raw_token);
      if (!workspace) return null;
      const context = await find_anonymous_workspace(workspace, database);
      if (context)
        cookies.set(
          SESSION_COOKIE_NAME,
          anonymous_cookie(workspace),
          session_cookie_options(ANONYMOUS_LIFETIME_DAYS * 86_400),
        );
      return context;
    }
    const context = await find_console_session(raw_token, database);
    if (context) {
      return context;
    }
  }
  return null;
}

export async function get_console_context(cookies: CookieStore, database: Database): Promise<ConsoleContext> {
  const existing = await find_console_context(cookies, database);
  if (existing) return existing;
  const workspace = create_provisional_workspace();
  const records = provisional_records(workspace);
  const context: ConsoleContext = {
    user: records.user,
    fresh_server: records.server,
    provisional: workspace,
    session_token: anonymous_cookie(workspace),
  };
  cookies.set(SESSION_COOKIE_NAME, context.session_token!, session_cookie_options(ANONYMOUS_LIFETIME_DAYS * 86_400));
  return context;
}

export async function persist_console_context(
  context: ConsoleContext,
  database: Database,
  client_address: string,
): Promise<ConsoleContext> {
  if (context.provisional) await materialize_workspace(context.provisional, database, client_address);
  return { user: context.user };
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
