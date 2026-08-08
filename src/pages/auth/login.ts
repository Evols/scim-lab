import type { APIRoute } from 'astro';
import { save_oidc_transaction } from '../../db';
import { get_console_context } from '../../lib/console_context';
import { get_oidc_configuration, oidc } from '../../lib/oidc';
import { app_config } from '../../lib/config';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
	const context = await get_console_context(cookies);
	if (!context.user.is_anonymous) return redirect('/', 303);
	const return_to_value = url.searchParams.get('return_to') ?? '/';
	const return_to = return_to_value.startsWith('/') && !return_to_value.startsWith('//') ? return_to_value : '/';
	const configuration = await get_oidc_configuration();
	const state = oidc.randomState();
	const nonce = oidc.randomNonce();
	const code_verifier = oidc.randomPKCECodeVerifier();
	const code_challenge = await oidc.calculatePKCECodeChallenge(code_verifier);
	await save_oidc_transaction(context.user.id, state, code_verifier, nonce, return_to);
	const authorization_url = oidc.buildAuthorizationUrl(configuration, {
		redirect_uri: `${app_config.app_origin}/auth/callback`,
		response_type: 'code',
		scope: 'openid profile email',
		state,
		nonce,
		code_challenge,
		code_challenge_method: 'S256',
	});
	return redirect(authorization_url.toString(), 302);
};
