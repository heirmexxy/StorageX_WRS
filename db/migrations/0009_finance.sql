-- Build 7: finance engine for any lender, Kitovu included. Products, loan request batches, one lien per receipt,
-- approval and disbursement by different people, repayments, margin watch and National Collateral Registry data.

CREATE TABLE loan_products (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organisations(id),     -- the lender (or Kitovu lending itself)
  name                 text NOT NULL,
  commodity_codes      text[] NOT NULL DEFAULT '{}',                   -- empty = any storable crop
  interest_bp_month    integer NOT NULL CHECK (interest_bp_month BETWEEN 0 AND 1000),   -- 250 = 2.5% a month, simple
  fee_bp               integer NOT NULL DEFAULT 0 CHECK (fee_bp BETWEEN 0 AND 1000),     -- one-off at disbursement
  tenor_days           integer NOT NULL CHECK (tenor_days BETWEEN 7 AND 365),
  min_kobo             bigint NOT NULL DEFAULT 0,
  max_kobo             bigint NOT NULL CHECK (max_kobo > 0),
  min_kyc_level        smallint NOT NULL DEFAULT 2 CHECK (min_kyc_level BETWEEN 1 AND 2),  -- 2 = lender account opened
  margin_call_ltv_bp   integer NOT NULL DEFAULT 8000,                 -- loan ÷ market value at which to warn
  liquidation_ltv_bp   integer NOT NULL DEFAULT 9000,
  active               boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  CHECK (margin_call_ltv_bp < liquidation_ltv_bp AND min_kobo <= max_kobo)
);

-- A batch of loan requests prepared by Kitovu for one lender and product.
CREATE TABLE loan_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,                   -- LB-<yymmdd>-<seq>
  lender_org_id uuid NOT NULL REFERENCES organisations(id),
  product_id    uuid NOT NULL REFERENCES loan_products(id),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','decided','withdrawn')),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_by  uuid REFERENCES users(id),
  submitted_at  timestamptz,
  note          text
);

CREATE TABLE loan_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES loan_batches(id),
  farmer_id      uuid NOT NULL REFERENCES farmers(id),
  receipt_ids    uuid[] NOT NULL CHECK (cardinality(receipt_ids) > 0),
  requested_kobo bigint NOT NULL CHECK (requested_kobo > 0),
  max_loan_kobo  bigint,                                -- under the lender's policy when submitted
  market_value_kobo bigint,
  review         jsonb,                                 -- batch reviewer agent: checks and a note for the credit officer
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','removed')),
  approved_kobo  bigint CHECK (approved_kobo > 0),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  loan_id        uuid,
  UNIQUE (batch_id, farmer_id)
);

CREATE TABLE loans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_no           text NOT NULL UNIQUE,               -- LN-<lender code>-<seq>
  lender_org_id     uuid NOT NULL REFERENCES organisations(id),
  product_id        uuid NOT NULL REFERENCES loan_products(id),
  line_id           uuid NOT NULL REFERENCES loan_lines(id),
  farmer_id         uuid NOT NULL REFERENCES farmers(id),
  principal_kobo    bigint NOT NULL CHECK (principal_kobo > 0),
  interest_bp_month integer NOT NULL,
  fee_bp            integer NOT NULL,
  tenor_days        integer NOT NULL,
  status            text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','disbursed','repaid','cancelled','written_off')),
  approved_by       uuid NOT NULL REFERENCES users(id),
  approved_at       timestamptz NOT NULL DEFAULT now(),
  disbursed_by      uuid REFERENCES users(id),
  disbursed_on      date,
  disbursement_ref  text,                               -- the lender's transfer reference, never an account number
  due_on            date,
  closed_at         timestamptz,
  CHECK (disbursed_by IS NULL OR disbursed_by <> approved_by)          -- approver and disburser are different people
);
ALTER TABLE loan_lines ADD CONSTRAINT loan_lines_loan_fk FOREIGN KEY (loan_id) REFERENCES loans(id);

-- One active lien per receipt, enforced by the database.
CREATE TABLE liens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id    uuid NOT NULL REFERENCES receipts(id),
  loan_id       uuid NOT NULL REFERENCES loans(id),
  lender_org_id uuid NOT NULL REFERENCES organisations(id),
  previous_status text NOT NULL,                        -- receipt status before the pledge, restored on release
  created_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  release_reason text
);
CREATE UNIQUE INDEX liens_one_active ON liens (receipt_id) WHERE released_at IS NULL;

-- Money on a loan. Interest is worked out from these and the dates; nothing is edited.
CREATE TABLE loan_entries (
  id           bigserial PRIMARY KEY,
  loan_id      uuid NOT NULL REFERENCES loans(id),
  kind         text NOT NULL CHECK (kind IN ('disbursement','fee','repayment','waiver')),
  amount_kobo  bigint NOT NULL CHECK (amount_kobo > 0),
  on_date      date NOT NULL,
  reference    text,
  note         text,
  recorded_by  uuid REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_entries_loan_idx ON loan_entries (loan_id, on_date);
CREATE TRIGGER loan_entries_append_only BEFORE UPDATE OR DELETE ON loan_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
