CREATE TABLE IF NOT EXISTS "set_asides" (
	"pot" text NOT NULL,
	"asset" text NOT NULL,
	"account" text NOT NULL,
	"set_aside" numeric(78, 0) DEFAULT '0' NOT NULL,
	"claimed" numeric(78, 0) DEFAULT '0' NOT NULL,
	"last_block" bigint NOT NULL,
	CONSTRAINT "set_asides_pot_asset_account_pk" PRIMARY KEY("pot","asset","account")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "set_asides_account_idx" ON "set_asides" USING btree ("account");
