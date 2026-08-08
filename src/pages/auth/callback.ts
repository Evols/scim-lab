import type { APIRoute } from "astro";
import { complete_oidc_login, replace_session, take_oidc_transaction } from "../../db";
import { session_cookie_name, session_cookie_options } from "../../lib/console_context";
import { get_oidc_configuration, oidc } from "../../lib/oidc";
import { app_config } from "../../lib/config";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  const state = url.searchParams.get("state");
  if (!state) {
    return new Response("Missing OpenID state.", { status: 400 });
  }
  const transaction = await take_oidc_transaction(state);
  if (!transaction) {
    return new Response("This sign-in attempt is invalid or expired.", {
      status: 400,
    });
  }
  try {
    const configuration = await get_oidc_configuration();
    const callback_url = new URL("/auth/callback", app_config.app_origin);
    callback_url.search = url.search;
    const tokens = await oidc.authorizationCodeGrant(configuration, callback_url, {
      pkceCodeVerifier: transaction.code_verifier,
      expectedState: state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub || !claims.iss) {
      throw new Error("The identity token did not include issuer and subject claims.");
    }
    const user = await complete_oidc_login(transaction.user_id, {
      issuer: String(claims.iss),
      subject: String(claims.sub),
      email: typeof claims.email === "string" ? claims.email : undefined,
      display_name: typeof claims.name === "string" ? claims.name : undefined,
    });
    const session_token = await replace_session(user.id);
    cookies.set(session_cookie_name, session_token, session_cookie_options());
    return redirect(transaction.return_to, 303);
  } catch (error) {
    console.error("OIDC callback failed", error);
    return new Response("OpenID sign-in could not be completed.", {
      status: 400,
    });
  }
};
