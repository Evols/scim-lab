import type { APIRoute } from 'astro';
import { handle_scim_request } from '../../../../lib/scim';

export const prerender = false;

const handler: APIRoute = ({ request, params }) => handle_scim_request(request, String(params.server_id ?? ''), params.path);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
