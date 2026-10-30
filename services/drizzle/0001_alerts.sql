CREATE TABLE "alerts" (
	"key" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
