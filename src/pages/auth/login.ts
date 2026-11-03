import type { APIRoute } from "astro";
import { find_console_context, persist_console_context } from "../../lib/session/context";
import { local_return_path } from "../../lib/session/bootstrap";
import { ProvisioningLimitError } from "../../lib/session/anonymous";
import { save_oidc_transaction } from "../../lib/session/authentication";
import { get_oidc_configuration, oidc } from "../../lib/session/oidc";
import { APP_CONFIG, oidc_is_configured } from "../../lib/config";
import { db } from "../../lib/database";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect, url, clientAddress }) => {
  if (!oidc_is_configured()) {
    return new Response("Sign-in is not configured for this deployment.", { status: 503 });
  }

  let context = await find_console_context(cookies, db);
  if (!context)
    return redirect(
      `/?signin=1&return_to=${encodeURIComponent(local_return_path(url.searchParams.get("return_to")))}`,
      303,
    );
  if (!context.user.is_anonymous) {
    return redirect("/", 303);
  }
  try {
    context = await persist_console_context(context, db, clientAddress);
  } catch (error) {
    if (error instanceof ProvisioningLimitError)
      return new Response(error.message, { status: 429, headers: { "retry-after": "60" } });
    throw error;
  }
  const return_to_value = url.searchParams.get("return_to") ?? "/";
  const return_to = return_to_value.startsWith("/") && !return_to_value.startsWith("//") ? return_to_value : "/";
  const configuration = await get_oidc_configuration();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const code_verifier = oidc.randomPKCECodeVerifier();
  const code_challenge = await oidc.calculatePKCECodeChallenge(code_verifier);
  await save_oidc_transaction(context.user.id, state, code_verifier, nonce, return_to, db);
  const authorization_url = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: `${APP_CONFIG.app_origin}/auth/callback`,
    response_type: "code",
    scope: APP_CONFIG.oidc_scopes,
    state,
    nonce,
    code_challenge,
    code_challenge_method: "S256",
  });
  return redirect(authorization_url.toString(), 302);
};
