DROP INDEX "idx_anonymous_bootstraps_created_at";--> statement-breakpoint
ALTER TABLE "anonymous_bootstraps" ADD COLUMN "allocation_ip_hash" text;--> statement-breakpoint
CREATE INDEX "idx_anonymous_bootstraps_ip_created_at" ON "anonymous_bootstraps" USING btree ("allocation_ip_hash","created_at");