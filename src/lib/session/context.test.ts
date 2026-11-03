import { describe, expect, it } from "vitest";
import { with_rollback_transaction } from "../database.testing";
import {
  FLASH_COOKIE_NAME,
  get_console_context,
  get_flash,
  SESSION_COOKIE_NAME,
  session_cookie_options,
  persist_console_context,
  type CookieStore,
} from "./context";
import { create_flash } from "./flash";

describe("session cookie context", () => {
  it("builds secure, HTTP-only session cookie options", () => {
    expect(session_cookie_options().maxAge).toBe(14 * 86_400);
    expect(session_cookie_options(123)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 123,
    });
  });

  it(
    "creates a context once and then restores it from the session cookie",
    with_rollback_transaction(async (transaction) => {
      const values = new Map<string, string>();
      const cookies: CookieStore = {
        get: (name) => {
          const value = values.get(name);
          return value === undefined ? undefined : { value };
        },
        set: (name, value) => {
          values.set(name, value);
        },
        delete: (name) => {
          values.delete(name);
        },
      };

      const created = await get_console_context(cookies, transaction);
      expect(values.get(SESSION_COOKIE_NAME)).toBe(created.session_token);
      const restored = await get_console_context(cookies, transaction);
      expect(restored.user.id).toBe(created.user.id);
      expect(restored.session_token).toBeUndefined();
    }),
  );

  it(
    "consumes the flash token stored in a cookie",
    with_rollback_transaction(async (transaction) => {
      const values = new Map<string, string>();
      const cookies: CookieStore = {
        get: (name) => {
          const value = values.get(name);
          return value === undefined ? undefined : { value };
        },
        set: (name, value) => {
          values.set(name, value);
        },
        delete: (name) => {
          values.delete(name);
        },
      };
      const context = await persist_console_context(
        await get_console_context(cookies, transaction),
        transaction,
        "192.0.2.99",
      );
      const token = await create_flash(context.user.id, { message: "Done" }, transaction);
      values.set(FLASH_COOKIE_NAME, token);

      expect(await get_flash(cookies, context.user.id, transaction)).toEqual({ message: "Done" });
      expect(values.has(FLASH_COOKIE_NAME)).toBe(false);
      expect(await get_flash(cookies, context.user.id, transaction)).toBeNull();
    }),
  );
});
