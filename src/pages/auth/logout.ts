import type { APIRoute } from "astro";
import { SESSION_COOKIE_NAME } from "../../lib/session/context";
import { delete_session } from "../../lib/session/session";
import { get_oidc_end_session_url } from "../../lib/session/oidc";
import { oidc_is_configured } from "../../lib/config";
import { db } from "../../lib/database";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect, request, url }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return new Response("Invalid request origin.", { status: 403 });
  }
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await delete_session(token, db);
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
