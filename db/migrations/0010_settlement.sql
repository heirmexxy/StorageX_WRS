-- Build 8: settlement. Sales of stock under receipts, buyer payments matched to sales, the payment waterfall
-- (Kitovu fees, then the lender's loan, then the farmer), payouts, and statements.

CREATE TABLE sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref               text NOT NULL UNIQUE,                 -- SL-<yymmdd>-<seq>; buyers quote it when paying
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  commodity_code    text NOT NULL REFERENCES commodities(code),
  buyer_org_id      uuid REFERENCES organisations(id),
  buyer_name        text NOT NULL,
  kobo_per_kg       bigint NOT NULL CHECK (kobo_per_kg > 0),
  status            text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','settled','cancelled')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  approved_at       timestamptz,
  note              text
);

-- One line per receipt sold. Every owner agrees to the price; a lender with a lien approves too.
CREATE TABLE sale_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id            uuid NOT NULL REFERENCES sales(id),
  receipt_id         uuid NOT NULL REFERENCES receipts(id),
  farmer_id          uuid NOT NULL REFERENCES farmers(id),
  kg                 numeric(14,2) NOT NULL CHECK (kg > 0),
  gross_kobo         bigint NOT NULL CHECK (gross_kobo > 0),
  previous_status    text NOT NULL,
  farmer_agreed_at   timestamptz,
  agreement_method   text CHECK (agreement_method IN ('code','paper_slip')),
  agreement_file_id  uuid REFERENCES files(id),
  agreement_by       uuid REFERENCES users(id),
  lender_org_id      uuid REFERENCES organisations(id),
  lender_approved_by uuid REFERENCES users(id),
  lender_approved_at timestamptz,
  UNIQUE (sale_id, receipt_id)
);

ALTER TABLE releases ADD COLUMN sale_id uuid REFERENCES sales(id);

-- Money received into Kitovu's collection account.
CREATE TABLE collections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_kobo  bigint NOT NULL CHECK (amount_kobo > 0),
  received_on  date NOT NULL,
  reference    text NOT NULL,                             -- bank reference or narration
  payer        text NOT NULL,
  sale_id      uuid REFERENCES sales(id),
  recorded_by  uuid NOT NULL REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  matched_by   uuid REFERENCES users(id),
  matched_at   timestamptz,
  note         text
);
CREATE INDEX collections_sale_idx ON collections (sale_id);

CREATE TABLE settlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid NOT NULL UNIQUE REFERENCES sales(id),
  settled_by  uuid NOT NULL REFERENCES users(id),
  settled_at  timestamptz NOT NULL DEFAULT now(),
  totals      jsonb NOT NULL
);

-- Who gets what, in order. Paid lines carry the transfer reference.
CREATE TABLE settlement_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id  uuid NOT NULL REFERENCES settlements(id),
  item_id        uuid NOT NULL REFERENCES sale_items(id),
  seq            smallint NOT NULL,
  party          text NOT NULL CHECK (party IN ('kitovu','lender','farmer')),
  label          text NOT NULL,
  amount_kobo    bigint NOT NULL CHECK (amount_kobo >= 0),
  org_id         uuid REFERENCES organisations(id),
  farmer_id      uuid REFERENCES farmers(id),
  loan_id        uuid REFERENCES loans(id),
  paid_ref       text,
  paid_at        timestamptz,
  paid_by        uuid REFERENCES users(id)
);
CREATE INDEX settlement_lines_farmer_idx ON settlement_lines (farmer_id);

ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check CHECK (purpose IN ('farmer_phone','farmer_consent','login_sms','intake_confirm','sale_agree'));
ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('id_document','selfie','consent_evidence','warehouse_document','intake_evidence','stock_evidence','price_evidence','sale_evidence','other'));
