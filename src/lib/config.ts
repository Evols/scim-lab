const is_production = process.env.NODE_ENV === 'production';

function required_value(name: string, development_fallback?: string): string {
	const value = process.env[name]?.trim();
	if (value) return value;
	if (!is_production && development_fallback) return development_fallback;
	throw new Error(`Missing required environment variable: ${name}`);
}

export const app_config = {
	database_url: required_value('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/scim_lab'),
	app_origin: required_value('APP_ORIGIN', 'http://localhost:4321').replace(/\/$/, ''),
	app_secret: required_value('APP_SECRET', 'scim-lab-development-secret-change-before-production'),
	oidc_issuer_url: process.env.OIDC_ISSUER_URL?.trim() ?? '',
	oidc_client_id: process.env.OIDC_CLIENT_ID?.trim() ?? '',
	oidc_client_secret: process.env.OIDC_CLIENT_SECRET?.trim() ?? '',
	is_production,
};

export function oidc_is_configured(): boolean {
	return Boolean(app_config.oidc_issuer_url && app_config.oidc_client_id && app_config.oidc_client_secret);
}
