-- StorageX WRS: core schema, first migration.
-- Conventions (see docs/data-standard.md):
--   * Primary keys are UUIDs; people-facing codes are separate, readable and unique.
--   * Money is integer kobo (NGN 1 = 100 kobo). Weights are kilograms, numeric(14,2).
--   * Phones are E.164 (+234...). Phones are NOT unique: rural households often share one.
--   * Receipt history lives in receipt_events, which is append-only and hash-chained.
--   * Nothing is hard-deleted; records carry a status and, where relevant, a reason.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes for verify tokens

-- ---------- Reference data ----------

CREATE TABLE states (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),   -- ISO 3166-2:NG suffix, e.g. 'TA'
  name        text NOT NULL UNIQUE,
  country     text NOT NULL DEFAULT 'NG'
);

CREATE TABLE lgas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code  text NOT NULL REFERENCES states(code),
  name        text NOT NULL,
  source      text NOT NULL DEFAULT 'manual',
  UNIQUE (state_code, name)
);

CREATE TABLE commodities (
  code                 text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name                 text NOT NULL UNIQUE,
  category             text NOT NULL CHECK (category IN ('grain','legume','oilseed','tuber','vegetable','tree_crop','oil','other')),
  unit                 text NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg','l')),
  storable             boolean NOT NULL DEFAULT true,        -- eligible for receipts
  max_moisture_pct     numeric(4,1),                         -- intake ceiling, null = not set yet
  active               boolean NOT NULL DEFAULT true
);

-- ---------- Organisations (every party that is not an individual) ----------

CREATE TYPE org_kind AS ENUM ('kitovu','lender','warehouse_operator','buyer','insurer','cooperative','field_partner_network','distribution_partner','other');

CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        org_kind NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('prospect','onboarding','active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Farmers ----------

CREATE TYPE kyc_status AS ENUM ('not_started','pending','verified','failed');

CREATE TABLE farmers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^SXF-[0-9]{6}$'),
  full_name          text NOT NULL,
  phone_e164         text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email              citext,
  sex                text CHECK (sex IN ('female','male')),         -- null = not recorded
  state_code         text REFERENCES states(code),
  lga_id             uuid REFERENCES lgas(id),
  community          text,                                          -- village / ward as given
  address_text       text,
  commodities        text[] NOT NULL DEFAULT '{}',                  -- commodity codes the farmer grows
  kyc                kyc_status NOT NULL DEFAULT 'not_started',     -- BVN/NIN check via provider; numbers are never stored here
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','merged','excluded')),
  merged_into        uuid REFERENCES farmers(id),
  needs_review       boolean NOT NULL DEFAULT false,
  source             text NOT NULL DEFAULT 'app' CHECK (source IN ('app','field_app','ussd','import','legacy_import')),
  legacy             jsonb,                                         -- provenance for imported rows
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'merged') = (merged_into IS NOT NULL))
);
CREATE INDEX farmers_phone_idx ON farmers (phone_e164);
CREATE INDEX farmers_state_idx ON farmers (state_code);

-- ---------- Field partners (agents) ----------

CREATE TABLE field_partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^SXA-[0-9]{5}$'),
  full_name     text NOT NULL,
  phone_e164    text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email         citext,
  org_id        uuid REFERENCES organisations(id),
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','legacy_unverified','excluded')),
  source        text NOT NULL DEFAULT 'app',
  legacy        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- Warehouses ----------
-- Tier: A Kitovu-operated; B partner-operated, Kitovu-managed; C two-key village store; D listed storage only (never backs loans).

CREATE TABLE warehouses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^WH-[A-Z]{2}-[A-Z0-9]{3,6}-[0-9]{2}$'),
  name               text NOT NULL,
  operator_org_id    uuid NOT NULL REFERENCES organisations(id),
  tier               char(1) NOT NULL CHECK (tier IN ('A','B','C','D')),
  status             text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','certified','active','dormant','closed')),
  state_code         text NOT NULL REFERENCES states(code),
  lga_id             uuid REFERENCES lgas(id),
  town               text,
  address_text       text,
  lat                numeric(9,6) CHECK (lat BETWEEN -90 AND 90),
  lng                numeric(9,6) CHECK (lng BETWEEN -180 AND 180),
  capacity_kg        numeric(14,2) CHECK (capacity_kg > 0),
  can_back_loans     boolean GENERATED ALWAYS AS (tier <> 'D' AND status IN ('certified','active')) STORED,
  needs_review       boolean NOT NULL DEFAULT false,
  legacy             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE insurance_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  insurer_name     text NOT NULL,
  policy_number    text,
  sum_insured_kobo bigint CHECK (sum_insured_kobo >= 0),
  cover_from       date,
  cover_to         date,
  perils           text[] NOT NULL DEFAULT '{}',
  loss_payees      uuid[] NOT NULL DEFAULT '{}',                  -- organisation ids
  status           text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','active','expired','cancelled')),
  legacy           jsonb,
  CHECK (cover_to IS NULL OR cover_from IS NULL OR cover_to > cover_from)
);

-- ---------- Receipts ----------
-- Current state is a projection; the truth is receipt_events.

CREATE TYPE receipt_status AS ENUM (
  'booked','received','graded','rejected','issued','submitted','pledged','financed',
  'sale_approved','partially_released','settled','closed','expired','cancelled','under_exception');

CREATE TABLE receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no            text NOT NULL UNIQUE,                      -- SX-<state>-<site>-<YYMMDD>-<seq>
  verify_token          text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16),'hex'),  -- public QR key, never sequential
  depositor_farmer_id   uuid REFERENCES farmers(id),
  depositor_org_id      uuid REFERENCES organisations(id),
  owner_farmer_id       uuid REFERENCES farmers(id),               -- owner can differ from depositor after a transfer
  owner_org_id          uuid REFERENCES organisations(id),
  warehouse_id          uuid NOT NULL REFERENCES warehouses(id),
  commodity_code        text NOT NULL REFERENCES commodities(code),
  grade                 text,
  moisture_pct          numeric(4,1) CHECK (moisture_pct BETWEEN 0 AND 100),
  bags                  integer CHECK (bags > 0),
  net_weight_kg         numeric(14,2) NOT NULL CHECK (net_weight_kg > 0),
  unit_price_kobo       bigint CHECK (unit_price_kobo >= 0),       -- per kg (or per l) at valuation
  value_kobo            bigint CHECK (value_kobo >= 0),
  status                receipt_status NOT NULL,
  distribution_enabled  boolean NOT NULL DEFAULT false,            -- may be offered via the distribution API
  issued_at             timestamptz,
  closed_at             timestamptz,
  closed_reason         text,
  source                text NOT NULL DEFAULT 'app',
  legacy                jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((depositor_farmer_id IS NULL) <> (depositor_org_id IS NULL)),
  CHECK ((owner_farmer_id IS NULL) <> (owner_org_id IS NULL)),
  CHECK (status NOT IN ('closed','settled','cancelled','expired') OR closed_at IS NOT NULL),
  CHECK (NOT distribution_enabled OR status = 'issued')
);
CREATE INDEX receipts_warehouse_idx ON receipts (warehouse_id, status);
CREATE INDEX receipts_owner_farmer_idx ON receipts (owner_farmer_id);

CREATE TABLE receipt_events (
  id            bigserial PRIMARY KEY,
  receipt_id    uuid NOT NULL REFERENCES receipts(id),
  seq           integer NOT NULL,
  event_type    text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,                                     -- 'user:<uuid>', 'org:<uuid>', 'system:<job>'
  data          jsonb NOT NULL DEFAULT '{}',
  prev_hash     text,
  hash          text NOT NULL,
  UNIQUE (receipt_id, seq)
);

CREATE FUNCTION receipt_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last record;
BEGIN
  SELECT seq, hash INTO last FROM receipt_events WHERE receipt_id = NEW.receipt_id ORDER BY seq DESC LIMIT 1 FOR UPDATE;
  NEW.seq := COALESCE(last.seq, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.hash := encode(sha256(convert_to(
      COALESCE(NEW.prev_hash,'') || '|' || NEW.receipt_id::text || '|' || NEW.seq || '|' || NEW.event_type || '|' ||
      to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || NEW.actor || '|' || NEW.data::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_events_chain BEFORE INSERT ON receipt_events FOR EACH ROW EXECUTE FUNCTION receipt_events_chain();

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER receipt_events_append_only BEFORE UPDATE OR DELETE ON receipt_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------- Import provenance and data-quality issues ----------

CREATE TABLE import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,
  source_hash  text NOT NULL,
  run_at       timestamptz NOT NULL DEFAULT now(),
  summary      jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE data_issues (
  id            bigserial PRIMARY KEY,
  batch_id      uuid REFERENCES import_batches(id),
  entity        text NOT NULL,
  entity_id     uuid,
  legacy_ref    text,
  severity      text NOT NULL CHECK (severity IN ('info','review','blocker')),
  code          text NOT NULL,
  detail        text NOT NULL,
  resolved_at   timestamptz,
  resolved_by   text
);

COMMIT;
