-- Build 6: valuation. Market prices from named sources, approved by a second person; reference prices as the
-- median of recent approved prices; per-lender policies (haircut, loan-to-value); daily valuation snapshots.

CREATE TABLE price_sources (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('market_survey','buyer_offer','exchange','government','other')),
  note       text,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO price_sources (name, kind, note) VALUES
  ('Kitovu market survey', 'market_survey', 'Field team visits to rural and urban markets'),
  ('Buyer offer', 'buyer_offer', 'Written offer from a processor or aggregator');

CREATE TABLE price_observations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity_code  text NOT NULL REFERENCES commodities(code),
  state_code      text REFERENCES states(code),
  market          text NOT NULL,                          -- e.g. "Kure Ultra Modern Market, Minna"
  source_id       uuid NOT NULL REFERENCES price_sources(id),
  observed_on     date NOT NULL,
  unit            text NOT NULL,                          -- as quoted: kg, bag_100kg, bag_50kg, tonne
  price_quoted_kobo bigint NOT NULL CHECK (price_quoted_kobo > 0),
  kobo_per_kg     bigint NOT NULL CHECK (kobo_per_kg > 0), -- normalised
  evidence_file_id uuid REFERENCES files(id),
  note            text,
  outlier_pct     numeric(6,1),                           -- distance from the reference price when entered
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  entered_by      uuid NOT NULL REFERENCES users(id),
  entered_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  CHECK (decided_by IS NULL OR decided_by <> entered_by)
);
CREATE INDEX price_obs_idx ON price_observations (commodity_code, status, observed_on DESC);

-- How a lender (or Kitovu, org_id NULL) values a crop. The haircut covers price falls and quality risk;
-- loan-to-value is the share of the discounted value a lender will advance.
CREATE TABLE valuation_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid REFERENCES organisations(id),     -- NULL = Kitovu default
  commodity_code   text NOT NULL REFERENCES commodities(code),
  haircut_bp       integer NOT NULL CHECK (haircut_bp BETWEEN 0 AND 9000),
  max_ltv_bp       integer NOT NULL CHECK (max_ltv_bp BETWEEN 0 AND 10000),
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX valuation_policies_uq ON valuation_policies (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), commodity_code);
INSERT INTO valuation_policies (org_id, commodity_code, haircut_bp, max_ltv_bp)
SELECT NULL, code, 1500, 7000 FROM commodities WHERE storable;

-- One row per receipt per day: what it was worth and exactly why.
CREATE TABLE receipt_valuations (
  id               bigserial PRIMARY KEY,
  receipt_id       uuid NOT NULL REFERENCES receipts(id),
  valued_on        date NOT NULL,
  held_kg          numeric(14,2) NOT NULL,
  kobo_per_kg      bigint,                                -- NULL = no usable price
  market_value_kobo bigint,
  haircut_bp       integer NOT NULL,
  max_ltv_bp       integer NOT NULL,
  lending_value_kobo bigint,                              -- market value less haircut
  max_loan_kobo    bigint,                                -- lending value × loan-to-value
  basis            jsonb NOT NULL,                        -- scope, window, observations used, median
  change_bp        integer,                               -- price change against the previous valuation
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, valued_on)
);
CREATE TRIGGER receipt_valuations_append_only BEFORE UPDATE OR DELETE ON receipt_valuations FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('id_document','selfie','consent_evidence','warehouse_document','intake_evidence','stock_evidence','price_evidence','other'));
