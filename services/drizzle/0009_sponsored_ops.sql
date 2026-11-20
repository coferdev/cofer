CREATE TABLE IF NOT EXISTS "sponsored_ops" (
	"user_op_hash" text PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"paymaster" text NOT NULL,
	"sponsored" boolean NOT NULL,
	"success" boolean NOT NULL,
	"gas_used" numeric(78, 0) NOT NULL,
	"cost_wei" numeric(78, 0) NOT NULL,
	"block" bigint NOT NULL,
	"day" text NOT NULL,
	"tx" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsored_ops_day_idx" ON "sponsored_ops" USING btree ("day");
