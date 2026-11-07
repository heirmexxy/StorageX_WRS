-- Build 4: receipts issued from accepted deliveries, the receipt ledger, and the public Receipt Passport.

ALTER TABLE receipts
  ADD COLUMN intake_id   uuid REFERENCES intakes(id),
  ADD COLUMN lot_no      smallint,                 -- 1..lots when one delivery is split into several receipts
  ADD COLUMN lots        smallint,
  ADD COLUMN issued_by   uuid REFERENCES users(id),
  ADD COLUMN signature   text,                     -- Ed25519 over the receipt's fixed facts (see src/lib/receipts.ts)
  ADD COLUMN sig_key_id  text;
CREATE INDEX receipts_intake_idx ON receipts (intake_id);
CREATE UNIQUE INDEX receipts_intake_lot_live ON receipts (intake_id, lot_no) WHERE status <> 'cancelled' AND intake_id IS NOT NULL;

-- The facts on a receipt never change after issue. Status, ownership, closing details, valuation and the
-- distribution switch may change, and every such change is also written to receipt_events.
CREATE FUNCTION receipts_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['status','owner_farmer_id','owner_org_id','closed_at','closed_reason','unit_price_kobo','value_kobo','distribution_enabled'];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'receipt % facts cannot be changed after issue', OLD.receipt_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipts_freeze BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_freeze();
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Recomputes a receipt's event chain exactly as the insert trigger built it. True only if every hash and
-- link matches and the sequence has no gaps.
CREATE FUNCTION receipt_events_verify(rid uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE e record; prev text := NULL; expect int := 1; h text;
BEGIN
  FOR e IN SELECT * FROM receipt_events WHERE receipt_id = rid ORDER BY seq LOOP
    IF e.seq <> expect OR e.prev_hash IS DISTINCT FROM prev THEN RETURN false; END IF;
    h := encode(sha256(convert_to(
      COALESCE(e.prev_hash,'') || '|' || e.receipt_id::text || '|' || e.seq || '|' || e.event_type || '|' ||
      to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || e.actor || '|' || e.data::text, 'UTF8')), 'hex');
    IF h <> e.hash THEN RETURN false; END IF;
    prev := e.hash; expect := expect + 1;
  END LOOP;
  RETURN expect > 1;
END $$;
