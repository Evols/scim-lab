import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable(
	'tasks',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
		created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		completed_at: integer('completed_at', { mode: 'timestamp_ms' }),
	},
	(table) => [index('idx_tasks_completed_created_at').on(table.completed, table.created_at)],
);

export type task_record = typeof tasks.$inferSelect;
