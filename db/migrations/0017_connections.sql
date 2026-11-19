-- Build 14: outside services. Payouts and buyer payment links through Paystack, identity checks through a
-- licensed provider, inbound texts, and a live price feed. Account numbers, BVNs and NINs are never stored:
-- only the provider's reference, the bank name, the last four digits and a keyed hash.

-- The account automated imports and webhooks act as. It can never sign in (no password, suspended).
INSERT INTO users (email, full_name, status) VALUES ('system@storagex.invalid', 'StorageX (automatic)', 'suspended') ON CONFLICT (email) DO NOTHING;

-- A farmer's payout destination at the payment provider.
CREATE TABLE payout_recipients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id       uuid NOT NULL REFERENCES farmers(id),
  provider        text NOT NULL DEFAULT 'paystack',
  recipient_code  text NOT NULL,
  bank_code       text NOT NULL,
  bank_name       text NOT NULL,
  account_last4   text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_name    text NOT NULL,              -- the name the bank holds, to compare with the farmer's
  name_match      text NOT NULL CHECK (name_match IN ('match','partial','override')),
  override_note   text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced')),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payout_recipients_one_active ON payout_recipients (farmer_id) WHERE status = 'active';

-- A payout of one settlement line: asked for by one person, approved and sent by another.
CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id         uuid NOT NULL UNIQUE REFERENCES settlement_lines(id),
  recipient_id    uuid NOT NULL REFERENCES payout_recipients(id),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  reference       text NOT NULL UNIQUE,
  transfer_code   text,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','sent','succeeded','failed','reversed','cancelled')),
  failure_reason  text,
  requested_by    uuid NOT NULL REFERENCES users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES users(id),
  sent_at         timestamptz,
  finished_at     timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- A link the buyer pays a sale through; the provider's webhook records and matches the payment.
CREATE TABLE payment_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         uuid NOT NULL REFERENCES sales(id),
  provider        text NOT NULL DEFAULT 'paystack',
  reference       text NOT NULL UNIQUE,
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  email           text NOT NULL,
  url             text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
  collection_id   uuid REFERENCES collections(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz
);

-- Webhooks from providers, kept only to ignore repeats (no payload: it can hold personal data).
CREATE TABLE provider_events (
  provider     text NOT NULL,
  event_key    text NOT NULL,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_key)
);

-- Identity lookups (BVN or NIN) through the licensed provider: the result, never the number or the record.
CREATE TABLE identity_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id     uuid NOT NULL REFERENCES farmers(id),
  kind          text NOT NULL CHECK (kind IN ('bvn','nin')),
  number_hash   text NOT NULL,
  last4         text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  provider      text NOT NULL,
  provider_ref  text,
  result        text NOT NULL CHECK (result IN ('match','partial','no_match','not_found','error')),
  detail        jsonb,
  checked_by    uuid NOT NULL REFERENCES users(id),
  checked_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_checks_farmer ON identity_checks (farmer_id, checked_at DESC);

-- The live price feed's observations come in as pending prices, approved by a person like any other.
INSERT INTO price_sources (name, kind, note) VALUES ('Live price feed', 'exchange', 'Imported each morning from the configured price feed; approved by Kitovu before use')
  ON CONFLICT (name) DO NOTHING;
CREATE UNIQUE INDEX price_obs_feed_once ON price_observations (source_id, commodity_code, COALESCE(state_code, ''), market, observed_on)
  WHERE note LIKE 'feed:%';
