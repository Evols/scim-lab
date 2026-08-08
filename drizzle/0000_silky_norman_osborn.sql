CREATE TABLE "console_flashes" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "console_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "console_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"oidc_issuer" text,
	"oidc_subject" text,
	"email" text,
	"display_name" text,
	"upgraded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_transactions" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text DEFAULT '/' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"auth_mode" text,
	"auth_success" boolean DEFAULT false NOT NULL,
	"request_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_body" text,
	"response_body" text,
	"request_truncated" boolean DEFAULT false NOT NULL,
	"response_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"external_id" text,
	"display_name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"auth_mode" text DEFAULT 'bearer' NOT NULL,
	"bearer_token_hash" text,
	"basic_username" text,
	"basic_password_hash" text,
	"credential_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_console_access_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"external_id" text,
	"user_name" text NOT NULL,
	"display_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_members" (
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_members_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "share_invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "console_flashes" ADD CONSTRAINT "console_flashes_user_id_console_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."console_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_user_id_console_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."console_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_transactions" ADD CONSTRAINT "oidc_transactions_user_id_console_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."console_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_events" ADD CONSTRAINT "scim_events_server_id_scim_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."scim_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_scim_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_server_id_scim_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."scim_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_servers" ADD CONSTRAINT "scim_servers_created_by_user_id_console_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."console_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_server_id_scim_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."scim_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_id_scim_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."scim_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_user_id_console_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."console_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_invites" ADD CONSTRAINT "share_invites_server_id_scim_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."scim_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_invites" ADD CONSTRAINT "share_invites_created_by_user_id_console_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."console_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_console_flashes_expires_at" ON "console_flashes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_console_sessions_user_id" ON "console_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_console_sessions_expires_at" ON "console_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_console_users_oidc_identity" ON "console_users" USING btree ("oidc_issuer","oidc_subject") WHERE "console_users"."oidc_issuer" is not null and "console_users"."oidc_subject" is not null;--> statement-breakpoint
CREATE INDEX "idx_oidc_transactions_expires_at" ON "oidc_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_scim_events_server_created_at" ON "scim_events" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_scim_events_server_id_id" ON "scim_events" USING btree ("server_id","id");--> statement-breakpoint
CREATE INDEX "idx_scim_group_members_user_id" ON "scim_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_scim_groups_server_id_created_at" ON "scim_groups" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_scim_groups_server_id_external_id" ON "scim_groups" USING btree ("server_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_scim_servers_created_by_user_id" ON "scim_servers" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_scim_servers_last_console_access_at" ON "scim_servers" USING btree ("last_console_access_at");--> statement-breakpoint
CREATE INDEX "idx_scim_users_server_id_created_at" ON "scim_users" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_scim_users_server_id_external_id" ON "scim_users" USING btree ("server_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_scim_users_server_user_name_lower" ON "scim_users" USING btree ("server_id",lower("user_name"));--> statement-breakpoint
CREATE INDEX "idx_server_members_user_id" ON "server_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_share_invites_server_id" ON "share_invites" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_share_invites_expires_at" ON "share_invites" USING btree ("expires_at");