ALTER TABLE "scim_group_members" RENAME COLUMN "user_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "scim_group_members" DROP CONSTRAINT "scim_group_members_user_id_scim_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_scim_group_members_user_id";--> statement-breakpoint
ALTER TABLE "scim_group_members" DROP CONSTRAINT "scim_group_members_group_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD COLUMN "member_type" text DEFAULT 'User' NOT NULL;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_member_type_member_id_pk" PRIMARY KEY("group_id","member_type","member_id");--> statement-breakpoint
ALTER TABLE "scim_groups" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_scim_group_members_member" ON "scim_group_members" USING btree ("member_type","member_id");
