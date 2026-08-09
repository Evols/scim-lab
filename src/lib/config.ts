const IS_PRODUCTION = process.env.NODE_ENV === "production";

function oidc_scopes(): string {
  const scopes = (process.env.OIDC_SCOPES?.trim() || "openid").split(/\s+/);
  if (!scopes.includes("openid")) {
    throw new Error("OIDC_SCOPES must include the openid scope.");
  }
  return [...new Set(scopes)].join(" ");
}

function required_value(name: string, development_fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (!IS_PRODUCTION && development_fallback) {
    return development_fallback;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

export const APP_CONFIG = {
  database_url: required_value("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/scim_lab"),
  app_origin: required_value("APP_ORIGIN", "http://localhost:4321").replace(/\/$/, ""),
  app_secret: required_value("APP_SECRET", "scim-lab-development-secret-change-before-production"),
  oidc_issuer_url: process.env.OIDC_ISSUER_URL?.trim() ?? "",
  oidc_client_id: process.env.OIDC_CLIENT_ID?.trim() ?? "",
  oidc_client_secret: process.env.OIDC_CLIENT_SECRET?.trim() ?? "",
  oidc_scopes: oidc_scopes(),
  is_production: IS_PRODUCTION,
};

export function oidc_is_configured(): boolean {
  return Boolean(APP_CONFIG.oidc_issuer_url && APP_CONFIG.oidc_client_id && APP_CONFIG.oidc_client_secret);
}
