import type { APIRoute } from "astro";
import { read_server_credential } from "../../lib/management/credential";
import { get_console_context } from "../../lib/session/context";
import { db } from "../../lib/database";

export const prerender = false;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const POST: APIRoute = async ({ cookies, request, url }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return json({ error: "Invalid request origin." }, 403);
  }
  const context = await get_console_context(cookies, db);
  if (context.user.is_anonymous) {
    return json(
      {
        error: "Anonymous credentials are already visible on the server home.",
      },
      403,
    );
  }
  const form = await request.formData();
  const server_id = String(form.get("server_id") ?? "");
  try {
    return json(await read_server_credential(context.user.id, server_id, db));
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Unable to reveal the credential.",
      },
      404,
    );
  }
};
