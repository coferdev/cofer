CREATE TABLE "feed_readings" (
	"asset" text PRIMARY KEY NOT NULL,
	"answer" numeric(78, 0) NOT NULL,
	"feed_updated_at" bigint NOT NULL,
	"multiplier" numeric(78, 0) NOT NULL,
	"mismatch_since" bigint,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
