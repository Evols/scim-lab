import type { APIRoute } from "astro";
import { SESSION_COOKIE_NAME } from "../../lib/session/context";
import { delete_session } from "../../lib/session/session";
import { get_oidc_end_session_url } from "../../lib/session/oidc";
import { oidc_is_configured } from "../../lib/config";
import { db } from "../../lib/database";
import { ProvisioningLimitError, read_anonymous_cookie, revoke_anonymous_cookie } from "../../lib/session/anonymous";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect, request, url, clientAddress }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return new Response("Invalid request origin.", { status: 403 });
  }
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    const workspace = read_anonymous_cookie(token);
    try {
      if (workspace) await revoke_anonymous_cookie(workspace, db, clientAddress);
      else await delete_session(token, db);
    } catch (error) {
      if (error instanceof ProvisioningLimitError)
        return new Response(error.message, { status: 429, headers: { "retry-after": "60" } });
      throw error;
    }
  }
  cookies.delete(SESSION_COOKIE_NAME, { path: "/" });

  if (oidc_is_configured()) {
    try {
      return redirect((await get_oidc_end_session_url()).toString(), 303);
    } catch (error) {
      console.error("OIDC sign-out failed", error);
    }
  }

  return redirect("/", 303);
};
