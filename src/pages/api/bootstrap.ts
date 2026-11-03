import type { APIRoute } from "astro";
import { db } from "../../lib/database";
import { BOOTSTRAP_COOKIE_NAME, local_return_path, valid_bootstrap_challenge } from "../../lib/session/bootstrap";
import { get_console_context } from "../../lib/session/context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, request, redirect, url }) => {
  if (request.headers.get("origin") !== url.origin) return new Response("Invalid request origin.", { status: 403 });
  const form = await request.formData();
  if (!valid_bootstrap_challenge(cookies.get(BOOTSTRAP_COOKIE_NAME)?.value, form.get("challenge"))) {
    return new Response("Please enable cookies and reload the page to create your server.", { status: 403 });
  }
  await get_console_context(cookies, db);
  cookies.delete(BOOTSTRAP_COOKIE_NAME, { path: "/" });
  const response = redirect(local_return_path(form.get("return_to")), 303);
  response.headers.set("cache-control", "private, no-store");
  return response;
};
