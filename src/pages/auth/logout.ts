import type { APIRoute } from 'astro';
import { delete_session } from '../../db';
import { session_cookie_name } from '../../lib/console_context';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect, request, url }) => {
	const origin = request.headers.get('origin');
	if (origin && origin !== url.origin) return new Response('Invalid request origin.', { status: 403 });
	const token = cookies.get(session_cookie_name)?.value;
	if (token) await delete_session(token);
	cookies.delete(session_cookie_name, { path: '/' });
	return redirect('/', 303);
};
