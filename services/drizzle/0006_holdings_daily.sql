CREATE TABLE IF NOT EXISTS "holdings_daily" (
	"pot" text NOT NULL,
	"asset" text NOT NULL,
	"day" text NOT NULL,
	"block" bigint NOT NULL,
	"block_time" bigint NOT NULL,
	"raw_balance" numeric(78, 0) NOT NULL,
	CONSTRAINT "holdings_daily_pot_asset_day_pk" PRIMARY KEY("pot","asset","day")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holdings_daily_pot_day_idx" ON "holdings_daily" USING btree ("pot","day");
