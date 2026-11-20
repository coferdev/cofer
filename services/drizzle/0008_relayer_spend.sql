CREATE TABLE IF NOT EXISTS "relayer_spend" (
	"tx" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"day" text NOT NULL,
	"gas_used" numeric(78, 0) NOT NULL,
	"gas_price" numeric(78, 0) NOT NULL,
	"cost_wei" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relayer_spend_day_idx" ON "relayer_spend" USING btree ("day");
