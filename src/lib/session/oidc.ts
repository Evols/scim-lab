import * as oidc from "openid-client";
import { APP_CONFIG, oidc_is_configured } from "../config.ts";

let cached_configuration: oidc.Configuration | undefined;

export async function get_oidc_configuration(): Promise<oidc.Configuration> {
  if (!oidc_is_configured()) {
    throw new Error("OpenID Connect is not configured for this deployment.");
  }

  if (!cached_configuration) {
    cached_configuration = await oidc.discovery(
      new URL(APP_CONFIG.oidc_issuer_url),
      APP_CONFIG.oidc_client_id,
      {
        client_secret: APP_CONFIG.oidc_client_secret,
        redirect_uris: [`${APP_CONFIG.app_origin}/auth/callback`],
      },
      oidc.ClientSecretPost(APP_CONFIG.oidc_client_secret),
    );
  }

  return cached_configuration;
}

export async function get_oidc_end_session_url(): Promise<URL> {
  const configuration = await get_oidc_configuration();
  return oidc.buildEndSessionUrl(configuration, {
    post_logout_redirect_uri: APP_CONFIG.app_origin,
  });
}

export { oidc };
