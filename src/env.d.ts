/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly DATABASE_URL?: string;
	readonly APP_ORIGIN?: string;
	readonly APP_SECRET?: string;
	readonly OIDC_ISSUER_URL?: string;
	readonly OIDC_CLIENT_ID?: string;
	readonly OIDC_CLIENT_SECRET?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
