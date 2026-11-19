CREATE TABLE IF NOT EXISTS "pending_admin_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"new_value" text NOT NULL,
	"max_staleness" integer,
	"eta" bigint NOT NULL,
	"queued_block" bigint NOT NULL,
	"queued_tx" text NOT NULL,
	"state" text NOT NULL,
	"resolved_block" bigint,
	"resolved_tx" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_admin_changes_state_idx" ON "pending_admin_changes" USING btree ("state");
