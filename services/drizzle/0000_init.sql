CREATE TYPE "public"."proposal_status" AS ENUM('collecting', 'ready', 'queued', 'executed', 'expired', 'stale', 'failed');--> statement-breakpoint
CREATE TABLE "assets" (
	"address" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"decimals" smallint NOT NULL,
	"is_stock" boolean DEFAULT false NOT NULL,
	"feed" text,
	"current_multiplier" text,
	"pending_multiplier" text,
	"pending_effective_at" timestamp with time zone,
	"listed_on_chain" boolean DEFAULT false NOT NULL,
	"status" text,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"pot" text NOT NULL,
	"member" text NOT NULL,
	"amount_usdg" numeric(78, 0) NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"funding_address" text,
	"spend_tx" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"address" text NOT NULL,
	"name" text NOT NULL,
	"args" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"pot" text NOT NULL,
	"asset" text NOT NULL,
	"raw_balance" numeric(78, 0) NOT NULL,
	"reserved" numeric(78, 0) DEFAULT '0' NOT NULL,
	"value_usdg" numeric(78, 0),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_pot_asset_pk" PRIMARY KEY("pot","asset")
);
--> statement-breakpoint
CREATE TABLE "link_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"tg_id" bigint NOT NULL,
	"purpose" text NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"pot" text NOT NULL,
	"address" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"shares" numeric(78, 0) DEFAULT '0' NOT NULL,
	"allowance" numeric(78, 0) DEFAULT '0' NOT NULL,
	"period" integer DEFAULT 0 NOT NULL,
	"period_start" bigint DEFAULT 0 NOT NULL,
	"spent" numeric(78, 0) DEFAULT '0' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_pot_address_pk" PRIMARY KEY("pot","address")
);
--> statement-breakpoint
CREATE TABLE "pots" (
	"address" text PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"creator_tg" bigint NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"threshold" smallint NOT NULL,
	"threshold_bps" integer NOT NULL,
	"guard_delay" integer NOT NULL,
	"max_slip_bps" integer NOT NULL,
	"entry_spread_bps" integer NOT NULL,
	"deposits_open" boolean DEFAULT true NOT NULL,
	"total_shares" numeric(78, 0) DEFAULT '0' NOT NULL,
	"plan_paid_until" timestamp with time zone,
	"created_block" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"pot" text NOT NULL,
	"kind" smallint NOT NULL,
	"data" text NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"epoch" bigint NOT NULL,
	"deadline" bigint NOT NULL,
	"summary" text NOT NULL,
	"proposer_tg" bigint NOT NULL,
	"status" "proposal_status" DEFAULT 'collecting' NOT NULL,
	"chat_message_id" integer,
	"queued_eta" bigint,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"proposal_id" text NOT NULL,
	"signer" text NOT NULL,
	"signature" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "signatures_proposal_id_signer_pk" PRIMARY KEY("proposal_id","signer")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"tg_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"address" text,
	"account_kind" text,
	"region" text,
	"linked_at" timestamp with time zone,
	CONSTRAINT "users_address_unique" UNIQUE("address")
);
--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_pot_pots_address_fk" FOREIGN KEY ("pot") REFERENCES "public"."pots"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_pot_pots_address_fk" FOREIGN KEY ("pot") REFERENCES "public"."pots"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_pot_pots_address_fk" FOREIGN KEY ("pot") REFERENCES "public"."pots"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_events_addr_idx" ON "chain_events" USING btree ("address","block");--> statement-breakpoint
CREATE UNIQUE INDEX "pots_chat_idx" ON "pots" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "proposals_pot_status_idx" ON "proposals" USING btree ("pot","status");