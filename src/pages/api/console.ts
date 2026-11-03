import type { APIRoute } from "astro";
import { rotate_server_auth } from "../../lib/management/credential";
import { create_share_invite, revoke_share_invite } from "../../lib/management/invite";
import { create_server, delete_server, reactivate_server, rename_server } from "../../lib/management/server";
import {
  FLASH_COOKIE_NAME,
  find_console_context,
  persist_console_context,
  session_cookie_options,
} from "../../lib/session/context";
import { ProvisioningLimitError } from "../../lib/session/anonymous";
import { create_flash } from "../../lib/session/flash";
import { db } from "../../lib/database";

export const prerender = false;

function safe_path(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export const POST: APIRoute = async ({ cookies, redirect, request, url, clientAddress }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return new Response("Invalid request origin.", { status: 403 });
  }
  let context = await find_console_context(cookies, db);
  if (!context) return new Response("Open the console before making changes.", { status: 401 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const server_id = String(form.get("server_id") ?? "");
  if (
    ![
      "create_server",
      "rename_server",
      "rotate_auth",
      "reactivate_server",
      "create_invite",
      "revoke_invite",
      "delete_server",
    ].includes(intent)
  ) {
    return new Response("Unknown console action.", { status: 400 });
  }
  if (context.provisional && server_id !== context.provisional.server_id)
    return new Response("Server not found.", { status: 404 });
  try {
    context = await persist_console_context(context, db, clientAddress);
  } catch (error) {
    if (error instanceof ProvisioningLimitError)
      return new Response(error.message, { status: 429, headers: { "retry-after": "60" } });
    throw error;
  }
  let redirect_to = safe_path(String(form.get("return_to") ?? "/"));
  let flash: Record<string, unknown> | null = null;
  try {
    if (intent === "create_server") {
      if (context.user.is_anonymous) {
        throw new Error("Sign in before creating another server.");
      }
      const result = await create_server(context.user.id, String(form.get("name") ?? "").trim(), db);
      redirect_to = `/?server=${result.server.id}`;
      flash = { type: "success", message: "Your SCIM server is ready." };
    } else if (intent === "rename_server") {
      await rename_server(context.user.id, server_id, String(form.get("name") ?? "").trim(), db);
      flash = { type: "success", message: "Server name updated." };
    } else if (intent === "rotate_auth") {
      const auth_mode = form.get("auth_mode") === "basic" ? "basic" : "bearer";
      await rotate_server_auth(context.user.id, server_id, auth_mode, db);
      redirect_to = `/?server=${server_id}`;
      flash = {
        type: "success",
        message: `${auth_mode === "bearer" ? "Bearer token" : "Basic credentials"} generated. Reveal it from the server home.`,
      };
    } else if (intent === "reactivate_server") {
      if (!(await reactivate_server(context.user.id, server_id, db))) {
        throw new Error("This server can no longer be reactivated.");
      }
      flash = { type: "success", message: "SCIM server reactivated." };
    } else if (intent === "create_invite") {
      const token = await create_share_invite(context.user.id, server_id, db);
      flash = {
        type: "invite",
        message: "Sharing link created. It can be reused for 30 days.",
        server_id,
        invite_url: `${url.origin}/invite/${token}`,
      };
    } else if (intent === "revoke_invite") {
      await revoke_share_invite(context.user.id, server_id, String(form.get("token_hash") ?? ""), db);
      flash = { type: "success", message: "Sharing link revoked." };
    } else if (intent === "delete_server") {
      await delete_server(context.user.id, server_id, db);
      redirect_to = "/";
      flash = { type: "success", message: "SCIM server deleted." };
    } else throw new Error("Unknown console action.");
  } catch (error) {
    flash = {
      type: "error",
      message: error instanceof Error ? error.message : "The action could not be completed.",
    };
  }
  if (flash) {
    const token = await create_flash(context.user.id, flash, db);
    cookies.set(FLASH_COOKIE_NAME, token, {
      ...session_cookie_options(300),
      maxAge: 300,
    });
  }
  return redirect(redirect_to, 303);
};
