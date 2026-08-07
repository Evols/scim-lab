import { env } from 'cloudflare:workers';
import { asc, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { tasks } from './schema';

function get_db() {
	const binding = (env as unknown as { DB?: D1Database }).DB;
	if (!binding) throw new Error('Cloudflare D1 binding `DB` is unavailable.');
	return drizzle(binding, { schema: { tasks } });
}

export function list_tasks() {
	return get_db().select().from(tasks).orderBy(asc(tasks.completed), desc(tasks.created_at));
}

export function create_task(title: string) {
	return get_db().insert(tasks).values({
		id: crypto.randomUUID(),
		title,
		completed: false,
		created_at: new Date(),
	});
}

export function set_task_completed(id: string, completed: boolean) {
	return get_db()
		.update(tasks)
		.set({ completed, completed_at: completed ? new Date() : null })
		.where(eq(tasks.id, id));
}

export function delete_task(id: string) {
	return get_db().delete(tasks).where(eq(tasks.id, id));
}

export function clear_completed_tasks() {
	return get_db().delete(tasks).where(eq(tasks.completed, true));
}
