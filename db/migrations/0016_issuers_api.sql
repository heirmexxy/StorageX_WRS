-- Receipt issuers, platform fees, and the partner API (keys, idempotency, webhooks, funding allocations).

-- ---------- issuers ----------
CREATE TABLE issuer_profiles (
  org_id            uuid PRIMARY KEY REFERENCES organisations(id),
  status            text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','certified','suspended')),
  tier              text NOT NULL DEFAULT 'C' CHECK (tier IN ('A','B','C','D')),
  guarantee_kobo    bigint NOT NULL DEFAULT 0 CHECK (guarantee_kobo >= 0),   -- first-loss deposit or bond held for lenders
  guarantee_ref     text,
  wareguard_waiver_until date,      -- Kitovu may waive the WareGuard rule for a pilot, with a reason and an end date
  waiver_reason     text,
  certified_by      uuid REFERENCES users(id),
  certified_at      timestamptz,
  suspended_by      uuid REFERENCES users(id),
  suspended_at      timestamptz,
  suspend_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issuer_warehouses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_org_id uuid NOT NULL REFERENCES organisations(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  basis         text NOT NULL CHECK (basis IN ('own','lease','kitovu_bays')),
  detail        text,                         -- e.g. "Bays 3 and 4" or the lease reference
  starts_on     date NOT NULL DEFAULT current_date,
  ends_on       date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  added_by      uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer_org_id, warehouse_id)
);

-- Each lender decides which issuers' receipts it lends against, and may cap the loan-to-value for an issuer.
CREATE TABLE lender_issuer_terms (
  lender_org_id uuid NOT NULL REFERENCES organisations(id),
  issuer_org_id uuid NOT NULL REFERENCES organisations(id),
  accepted      boolean NOT NULL,
  max_ltv_bp    int CHECK (max_ltv_bp BETWEEN 1000 AND 9000),
  decided_by    uuid NOT NULL REFERENCES users(id),
  decided_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lender_org_id, issuer_org_id)
);

-- Who issued the receipt (NULL = Kitovu). A fact of the receipt, fixed at issue.
ALTER TABLE receipts ADD COLUMN issuer_org_id uuid REFERENCES organisations(id);
CREATE INDEX receipts_issuer ON receipts (issuer_org_id) WHERE issuer_org_id IS NOT NULL;
-- Who prepared a loan request (NULL = Kitovu).
ALTER TABLE loan_batches ADD COLUMN prepared_by_org_id uuid REFERENCES organisations(id);

-- ---------- platform fees Kitovu earns ----------
CREATE TABLE platform_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  kind        text NOT NULL CHECK (kind IN ('issuance','origination','certification','wareguard','other')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo >= 0),
  ref         text NOT NULL,                  -- receipt or loan number, or an invoice reference
  basis       jsonb,
  status      text NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','waived')),
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_by  uuid REFERENCES users(id),
  settled_at  timestamptz,
  UNIQUE (kind, ref)
);

-- ---------- partner API ----------
CREATE TABLE api_clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organisations(id),
  user_id          uuid NOT NULL REFERENCES users(id),   -- the person the key acts as: their role limits it too
  name             text NOT NULL,
  key_prefix       text NOT NULL UNIQUE,
  key_hash         text NOT NULL,
  scopes           text[] NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  webhook_url      text,
  webhook_secret   text,                                  -- encrypted at rest
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users(id)
);

CREATE TABLE api_idempotency (
  client_id    uuid NOT NULL REFERENCES api_clients(id),
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       int NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, key)
);

CREATE TABLE webhook_events (
  id           bigserial PRIMARY KEY,
  client_id    uuid NOT NULL REFERENCES api_clients(id),
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  dedupe       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_status  int,
  last_error   text,
  UNIQUE (client_id, dedupe)
);
CREATE INDEX webhook_events_due ON webhook_events (next_at) WHERE delivered_at IS NULL;

-- How a funding partner (a fintech lending its users' money) splits a loan among its own users. StorageX
-- holds only the partner's opaque reference for each user: never a name, phone, email or account number.
CREATE TABLE funding_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id     uuid NOT NULL REFERENCES loans(id),
  user_ref    text NOT NULL CHECK (user_ref ~ '^[A-Za-z0-9_.:-]{3,64}$'),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, user_ref)
);

-- May organisation `org` (NULL = Kitovu, which sees all) work at warehouse `wh`? Its operator, or an issuer with
-- an active link to it (own, leased or bays in a Kitovu warehouse).
CREATE FUNCTION wh_access(wh uuid, org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT org IS NULL
      OR EXISTS (SELECT 1 FROM warehouses w WHERE w.id = wh AND w.operator_org_id = org)
      OR EXISTS (SELECT 1 FROM issuer_warehouses iw WHERE iw.warehouse_id = wh AND iw.issuer_org_id = org AND iw.status = 'active'
                   AND iw.starts_on <= current_date AND (iw.ends_on IS NULL OR iw.ends_on >= current_date))
$$;
