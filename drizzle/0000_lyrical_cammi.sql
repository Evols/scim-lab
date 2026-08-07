CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_completed_created_at` ON `tasks` (`completed`,`created_at`);
--> statement-breakpoint
PRAGMA optimize;
