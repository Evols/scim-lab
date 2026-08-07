import { env } from 'cloudflare:workers';
import { asc, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { tasks } from './schema';

function getDb() {
	const binding = (env as unknown as { DB?: D1Database }).DB;
	if (!binding) throw new Error('Cloudflare D1 binding `DB` is unavailable.');
	return drizzle(binding, { schema: { tasks } });
}

export function listTasks() {
	return getDb().select().from(tasks).orderBy(asc(tasks.completed), desc(tasks.createdAt));
}

export function createTask(title: string) {
	return getDb().insert(tasks).values({
		id: crypto.randomUUID(),
		title,
		completed: false,
		createdAt: new Date(),
	});
}

export function setTaskCompleted(id: string, completed: boolean) {
	return getDb()
		.update(tasks)
		.set({ completed, completedAt: completed ? new Date() : null })
		.where(eq(tasks.id, id));
}

export function deleteTask(id: string) {
	return getDb().delete(tasks).where(eq(tasks.id, id));
}

export function clearCompletedTasks() {
	return getDb().delete(tasks).where(eq(tasks.completed, true));
}
