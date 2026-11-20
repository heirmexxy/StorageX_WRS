-- Retention: the USSD log may be trimmed by the nightly job (older lines only); it still cannot be edited.
DROP TRIGGER ussd_log_append_only ON ussd_log;
CREATE TRIGGER ussd_log_no_update BEFORE UPDATE ON ussd_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION ussd_log_trim_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.created_at > now() - interval '30 days' THEN RAISE EXCEPTION 'USSD log lines younger than 30 days cannot be removed'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER ussd_log_trim_only BEFORE DELETE ON ussd_log FOR EACH ROW EXECUTE FUNCTION ussd_log_trim_only();
CREATE INDEX IF NOT EXISTS files_intake_evidence_idx ON files (entity_id) WHERE kind = 'intake_evidence';

-- Paystack transfers that wait for the one-time code Paystack sends to the account owner (the account keeps codes on).
ALTER TABLE payouts DROP CONSTRAINT payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('requested','awaiting_otp','sent','succeeded','failed','reversed','cancelled'));

-- Farmers registered offline on the field app carry the phone's record id, so an upload repeated after a dropped
-- connection finds the same farmer instead of making a second one.
ALTER TABLE farmers ADD COLUMN offline_ref uuid UNIQUE;
