import type { APIRoute } from "astro";
import { delete_session } from "../../db";
import { SESSION_COOKIE_NAME } from "../../lib/console_context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect, request, url }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return new Response("Invalid request origin.", { status: 403 });
  }
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await delete_session(token);
  }
  cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
  return redirect("/", 303);
};
