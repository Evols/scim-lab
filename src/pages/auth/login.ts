import type { APIRoute } from "astro";
import { get_console_context } from "../../lib/session/context";
import { save_oidc_transaction } from "../../lib/session/authentication";
import { get_oidc_configuration, oidc } from "../../lib/session/oidc";
import { APP_CONFIG, oidc_is_configured } from "../../lib/config";
import { db } from "../../lib/database";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  if (!oidc_is_configured()) {
    return new Response("Sign-in is not configured for this deployment.", { status: 503 });
  }

  const context = await get_console_context(cookies, db);
  if (!context.user.is_anonymous) {
    return redirect("/", 303);
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
