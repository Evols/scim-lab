import type { APIRoute } from "astro";
import {
  create_flash,
  create_server,
  create_share_invite,
  delete_server,
  reactivate_server,
  rename_server,
  revoke_share_invite,
  rotate_server_auth,
} from "../../db";
import { flash_cookie_name, get_console_context, session_cookie_options } from "../../lib/console_context";

export const prerender = false;

function safe_path(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export const POST: APIRoute = async ({ cookies, redirect, request, url }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return new Response("Invalid request origin.", { status: 403 });
  }
  const context = await get_console_context(cookies);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const server_id = String(form.get("server_id") ?? "");
  let redirect_to = safe_path(String(form.get("return_to") ?? "/"));
  let flash: Record<string, unknown> | null = null;
  try {
    if (intent === "create_server") {
      if (context.user.is_anonymous) {
        throw new Error("Sign in before creating another server.");
      }
      const result = await create_server(context.user.id, String(form.get("name") ?? "").trim());
      redirect_to = `/?server=${result.server.id}`;
      flash = { type: "success", message: "Your SCIM server is ready." };
    } else if (intent === "rename_server") {
      await rename_server(context.user.id, server_id, String(form.get("name") ?? "").trim());
      flash = { type: "success", message: "Server name updated." };
    } else if (intent === "rotate_auth") {
      const auth_mode = form.get("auth_mode") === "basic" ? "basic" : "bearer";
      await rotate_server_auth(context.user.id, server_id, auth_mode);
      redirect_to = `/?server=${server_id}`;
      flash = {
        type: "success",
        message: `${auth_mode === "bearer" ? "Bearer token" : "Basic credentials"} generated. Reveal it from the server home.`,
      };
    } else if (intent === "reactivate_server") {
      if (!(await reactivate_server(context.user.id, server_id))) {
        throw new Error("This server can no longer be reactivated.");
      }
      flash = { type: "success", message: "SCIM server reactivated." };
    } else if (intent === "create_invite") {
      const token = await create_share_invite(context.user.id, server_id);
      flash = {
        type: "invite",
        message: "Sharing link created. It can be reused for 30 days.",
        server_id,
        invite_url: `${url.origin}/invite/${token}`,
      };
    } else if (intent === "revoke_invite") {
      await revoke_share_invite(context.user.id, server_id, String(form.get("token_hash") ?? ""));
      flash = { type: "success", message: "Sharing link revoked." };
    } else if (intent === "delete_server") {
      await delete_server(context.user.id, server_id);
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
    const token = await create_flash(context.user.id, flash);
    cookies.set(flash_cookie_name, token, {
      ...session_cookie_options(300),
      maxAge: 300,
    });
  }
  return redirect(redirect_to, 303);
};
