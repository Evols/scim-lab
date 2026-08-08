import { create_anonymous_context, find_console_session, purge_expired_records, take_flash, type console_context } from '../db';
import { app_config } from './config';

interface cookie_value {
	value: string;
}

export interface cookie_store {
	get(name: string): cookie_value | undefined;
	set(name: string, value: string, options: Record<string, unknown>): void;
	delete(name: string, options?: Record<string, unknown>): void;
}

export const session_cookie_name = 'scim_lab_session';
export const flash_cookie_name = 'scim_lab_flash';

export function session_cookie_options(max_age = 30 * 86_400) {
	return {
		httpOnly: true,
		secure: app_config.is_production,
		sameSite: 'lax' as const,
		path: '/',
		maxAge: max_age,
	};
}

export async function get_console_context(cookies: cookie_store): Promise<console_context> {
	await purge_expired_records();
	const raw_token = cookies.get(session_cookie_name)?.value;
	if (raw_token) {
		const context = await find_console_session(raw_token);
		if (context) return context;
	}
	const context = await create_anonymous_context();
	cookies.set(session_cookie_name, context.session_token!, session_cookie_options(37 * 86_400));
	return context;
}

export async function get_flash(cookies: cookie_store, user_id: string): Promise<Record<string, unknown> | null> {
	const token = cookies.get(flash_cookie_name)?.value;
	if (!token) return null;
	cookies.delete(flash_cookie_name, { path: '/' });
	return take_flash(user_id, token);
}
