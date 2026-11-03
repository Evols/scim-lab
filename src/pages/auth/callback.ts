import type { APIRoute } from "astro";
import { complete_oidc_login, take_oidc_transaction } from "../../lib/session/authentication";
import { find_console_context, SESSION_COOKIE_NAME, session_cookie_options } from "../../lib/session/context";
import { get_oidc_configuration, oidc } from "../../lib/session/oidc";
import { replace_session } from "../../lib/session/session";
import { APP_CONFIG } from "../../lib/config";
import { db } from "../../lib/database";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  const state = url.searchParams.get("state");
  if (!state) {
    return new Response("Missing OpenID state.", { status: 400 });
  }

  const transaction = await take_oidc_transaction(state, db);
  if (!transaction) {
    return new Response("This sign-in attempt is invalid or expired.", {
      status: 400,
    });
  }

  const current_context = await find_console_context(cookies, db);
  if (!current_context || !current_context.user.is_anonymous || current_context.user.id !== transaction.user_id) {
    return new Response("This sign-in attempt does not belong to the current session.", {
      status: 400,
    });
  }

  try {
    const configuration = await get_oidc_configuration();
    const callback_url = new URL("/auth/callback", APP_CONFIG.app_origin);
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
    const user_info = await oidc.fetchUserInfo(configuration, tokens.access_token, claims.sub);
    const user = await complete_oidc_login(
      transaction.user_id,
      {
        issuer: String(claims.iss),
        subject: String(claims.sub),
        email:
          typeof user_info.email === "string"
            ? user_info.email
            : typeof claims.email === "string"
              ? claims.email
              : undefined,
        display_name:
          typeof user_info.name === "string"
            ? user_info.name
            : typeof user_info.preferred_username === "string"
              ? user_info.preferred_username
              : typeof claims.name === "string"
                ? claims.name
                : typeof claims.preferred_username === "string"
                  ? claims.preferred_username
                  : undefined,
      },
      db,
    );
    const session_token = await replace_session(user.id, db);
    cookies.set(SESSION_COOKIE_NAME, session_token, session_cookie_options());
    return redirect(transaction.return_to, 303);
  } catch (error) {
    console.error("OIDC callback failed", error);
    return new Response("OpenID sign-in could not be completed.", {
      status: 400,
    });
  }
};
