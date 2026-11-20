CREATE TABLE IF NOT EXISTS "fees" (
	"id" text PRIMARY KEY NOT NULL,
	"pot" text NOT NULL,
	"kind" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"months" smallint,
	"block" bigint NOT NULL,
	"tx" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fees_pot_block_idx" ON "fees" USING btree ("pot","block");
