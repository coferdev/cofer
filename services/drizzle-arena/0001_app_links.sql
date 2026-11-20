-- App sign-in links are single use (spec §6.3): each one's jti is recorded when it is exchanged.
CREATE TABLE arena_used_links (
  jti text PRIMARY KEY,
  tg bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX arena_used_links_expires ON arena_used_links (expires_at);
