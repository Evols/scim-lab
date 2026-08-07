import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable(
	'tasks',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
	},
	(table) => [index('idx_tasks_completed_created_at').on(table.completed, table.createdAt)],
);

export type Task = typeof tasks.$inferSelect;
