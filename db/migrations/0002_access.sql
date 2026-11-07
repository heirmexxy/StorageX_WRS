-- Access: users, organisation memberships, sessions, invitations, password resets, 2FA recovery codes,
-- rate limits and the platform audit log.

CREATE TYPE user_status AS ENUM ('invited','active','suspended');

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  full_name         text NOT NULL,
  phone_e164        text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  password_hash     text,
  totp_secret_enc   text,                      -- AES-GCM with a key derived from APP_SECRET
  totp_enabled      boolean NOT NULL DEFAULT false,
  status            user_status NOT NULL DEFAULT 'invited',
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR password_hash IS NOT NULL)
);

-- A user acts for one or more organisations, with one role in each. Valid roles per organisation kind live in
-- src/lib/rbac.ts; the application refuses any other combination.
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  role        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (user_id, org_id)
);
CREATE INDEX memberships_org_idx ON memberships (org_id) WHERE status = 'active';

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL UNIQUE,
  user_id        uuid NOT NULL REFERENCES users(id),
  active_org_id  uuid REFERENCES organisations(id),
  twofa_ok       boolean NOT NULL DEFAULT false,
  ip             text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  email        citext NOT NULL,
  full_name    text NOT NULL,
  org_id       uuid NOT NULL REFERENCES organisations(id),
  role         text NOT NULL,
  invited_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE rate_limits (
  key           text PRIMARY KEY,
  count         integer NOT NULL,
  window_start  timestamptz NOT NULL
);

-- Platform audit log: every security-relevant or data-changing action. Append-only and hash-chained in one
-- global sequence, so a deleted or edited row breaks the chain. org_id scopes what each lender may see.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id  uuid REFERENCES users(id),
  actor_label    text NOT NULL,          -- 'user:<email>', 'system:<job>', 'cli'
  org_id         uuid REFERENCES organisations(id),
  action         text NOT NULL,
  entity         text,
  entity_id      text,
  ip             text,
  data           jsonb NOT NULL DEFAULT '{}',
  prev_hash      text,
  hash           text NOT NULL
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, id DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  SELECT hash INTO last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := last_hash;
  NEW.hash := encode(sha256(convert_to(
      COALESCE(NEW.prev_hash,'') || '|' || NEW.id || '|' || to_char(NEW.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
      COALESCE(NEW.actor_user_id::text,'') || '|' || NEW.actor_label || '|' || COALESCE(NEW.org_id::text,'') || '|' || NEW.action || '|' ||
      COALESCE(NEW.entity,'') || '|' || COALESCE(NEW.entity_id,'') || '|' || NEW.data::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Recomputes the chain; returns the first broken id, or NULL when intact.
CREATE FUNCTION audit_log_verify() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r record; expected text; prev text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    expected := encode(sha256(convert_to(
      COALESCE(prev,'') || '|' || r.id || '|' || to_char(r.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
      COALESCE(r.actor_user_id::text,'') || '|' || r.actor_label || '|' || COALESCE(r.org_id::text,'') || '|' || r.action || '|' ||
      COALESCE(r.entity,'') || '|' || COALESCE(r.entity_id,'') || '|' || r.data::text, 'UTF8')), 'hex');
    IF r.prev_hash IS DISTINCT FROM prev OR r.hash <> expected THEN RETURN r.id; END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;
