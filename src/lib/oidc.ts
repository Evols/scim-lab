import * as oidc from "openid-client";
import { app_config, oidc_is_configured } from "./config";

let cached_configuration: oidc.Configuration | undefined;

export async function get_oidc_configuration(): Promise<oidc.Configuration> {
  if (!oidc_is_configured()) {
    throw new Error("OpenID Connect is not configured for this deployment.");
  }

  if (!cached_configuration) {
    cached_configuration = await oidc.discovery(
      new URL(app_config.oidc_issuer_url),
      app_config.oidc_client_id,
      {
        client_secret: app_config.oidc_client_secret,
        redirect_uris: [`${app_config.app_origin}/auth/callback`],
      },
      oidc.ClientSecretPost(app_config.oidc_client_secret),
    );
  }

  return cached_configuration;
}

export { oidc };
