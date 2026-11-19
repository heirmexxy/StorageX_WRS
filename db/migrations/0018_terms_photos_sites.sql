-- Build 15: storage terms on receipts, farmer and agribusiness profile photos, warehouse and commodity set-up.

-- ---------- Commodities: how long each crop may be stored on one receipt ----------
ALTER TABLE commodities ADD COLUMN max_storage_months smallint NOT NULL DEFAULT 6 CHECK (max_storage_months BETWEEN 1 AND 6);
ALTER TABLE commodities ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE commodities ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- Fresh produce keeps for weeks, not months.
UPDATE commodities SET max_storage_months = 1 WHERE category = 'vegetable';
UPDATE commodities SET max_storage_months = 3 WHERE category = 'tuber';

-- ---------- Receipts: the storage term chosen at issue (1 to 6 months) ----------
-- storage_months is the term agreed at issue and never changes. storage_until moves only when the term is
-- extended; every extension is written to receipt_events.
ALTER TABLE receipts ADD COLUMN storage_months smallint CHECK (storage_months BETWEEN 1 AND 6);
ALTER TABLE receipts ADD COLUMN storage_until date;
ALTER TABLE receipts ADD COLUMN term_reminded_on date;      -- the last "term ends soon" reminder, so it goes once

ALTER TABLE receipts DISABLE TRIGGER receipts_freeze;
UPDATE receipts SET storage_months = 6, storage_until = ((COALESCE(issued_at, created_at) AT TIME ZONE 'Africa/Lagos')::date + interval '6 months')::date
  WHERE storage_until IS NULL;
ALTER TABLE receipts ENABLE TRIGGER receipts_freeze;
-- Receipts made by other paths (imports, tests) get the full six months unless a term is given.
CREATE FUNCTION receipts_term_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.storage_months := COALESCE(NEW.storage_months, 6);
  NEW.storage_until := COALESCE(NEW.storage_until, ((COALESCE(NEW.issued_at, now()) AT TIME ZONE 'Africa/Lagos')::date + make_interval(months => NEW.storage_months))::date);
  RETURN NEW;
END $$;
CREATE TRIGGER receipts_term_default BEFORE INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_term_default();
ALTER TABLE receipts ADD CONSTRAINT receipts_term_set CHECK (storage_months IS NOT NULL AND storage_until IS NOT NULL);
CREATE INDEX receipts_storage_until_idx ON receipts (storage_until) WHERE status NOT IN ('closed','settled','cancelled','expired');

CREATE OR REPLACE FUNCTION receipts_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['status','owner_farmer_id','owner_org_id','closed_at','closed_reason','unit_price_kobo','value_kobo','distribution_enabled','storage_until','term_reminded_on'];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'receipt % facts cannot be changed after issue', OLD.receipt_no;
  END IF;
  IF NEW.storage_until < OLD.storage_until THEN
    RAISE EXCEPTION 'receipt % storage term can be extended, not shortened', OLD.receipt_no;
  END IF;
  RETURN NEW;
END $$;

-- ---------- Farmers: individuals and agribusinesses, with a profile photo ----------
ALTER TABLE farmers ADD COLUMN kind text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','agribusiness'));
ALTER TABLE farmers ADD COLUMN business_reg_no text;        -- company registration number (public record), agribusinesses only
ALTER TABLE farmers ADD COLUMN contact_person text;         -- who speaks for an agribusiness
ALTER TABLE farmers ADD COLUMN contact_role text;
ALTER TABLE farmers ADD COLUMN profile_photo_id uuid REFERENCES files(id);   -- shown on the record; photo_file_id stays the approved ID selfie (Kitovu only)
ALTER TABLE farmers ADD CONSTRAINT farmers_business_fields CHECK (kind = 'agribusiness' OR (business_reg_no IS NULL AND contact_person IS NULL AND contact_role IS NULL));

ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('id_document','selfie','consent_evidence','warehouse_document','intake_evidence','stock_evidence','price_evidence','sale_evidence','profile_photo','other'));

-- ---------- Warehouses: when the record was made and by whom ----------
ALTER TABLE warehouses ADD COLUMN created_by uuid REFERENCES users(id);

-- ---------- Alerts: a receipt's storage term ending ----------
ALTER TABLE alerts DROP CONSTRAINT alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('price_warning','margin_call','liquidation','price_drop','sale_proposed','sale_approved','sale_cancelled','sale_settled','warehouse_condition','warehouse_offline','storage_term'));
