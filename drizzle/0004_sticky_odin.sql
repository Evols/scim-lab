CREATE TABLE "anonymous_bootstraps" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_anonymous_bootstraps_expires_at" ON "anonymous_bootstraps" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_anonymous_bootstraps_created_at" ON "anonymous_bootstraps" USING btree ("created_at");