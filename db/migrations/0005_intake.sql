-- Build 3: deliveries recorded at the warehouse gate, offline first, with an evidence pack.
-- A record is captured on a phone (often with no network), sealed with a SHA-256 hash over its fields and photo
-- hashes, chained to the previous record on the same phone, and uploaded later. After upload the captured facts
-- cannot be changed (trigger below); mistakes are rejected and recaptured, never edited.

ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('id_document','selfie','consent_evidence','warehouse_document','intake_evidence','other'));

-- Phones that have uploaded records, with the end of their record chain.
CREATE TABLE intake_devices (
  id            uuid PRIMARY KEY,                 -- generated on the phone at first use
  first_user_id uuid REFERENCES users(id),
  last_seq      integer NOT NULL DEFAULT 0,
  last_hash     text,
  user_agent    text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE intakes (
  id                 uuid PRIMARY KEY,            -- generated on the phone: re-uploading is harmless
  ref                text NOT NULL UNIQUE,        -- readable: IN-<device 4>-<seq>
  device_id          uuid NOT NULL REFERENCES intake_devices(id),
  device_seq         integer NOT NULL CHECK (device_seq > 0),
  prev_hash          text,                        -- hash of the previous record on this phone
  evidence_hash      text NOT NULL,               -- SHA-256 over the canonical record (fields + photo hashes)
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  farmer_id          uuid NOT NULL REFERENCES farmers(id),
  commodity_code     text NOT NULL REFERENCES commodities(code),
  weighings          jsonb NOT NULL,              -- [{bags, gross_kg, photo}] read off the scale display
  bags               integer NOT NULL CHECK (bags > 0),
  gross_kg           numeric(14,2) NOT NULL CHECK (gross_kg > 0),
  tare_per_bag_kg    numeric(6,3) NOT NULL CHECK (tare_per_bag_kg >= 0),
  net_kg             numeric(14,2) NOT NULL CHECK (net_kg > 0),
  moisture_pct       numeric(4,1) NOT NULL CHECK (moisture_pct BETWEEN 0 AND 60),
  foreign_matter_pct numeric(4,1) CHECK (foreign_matter_pct BETWEEN 0 AND 100),
  damaged_pct        numeric(4,1) CHECK (damaged_pct BETWEEN 0 AND 100),
  grade              text,
  stack_ref          text,
  notes              text,
  farmer_confirmation text NOT NULL CHECK (farmer_confirmation IN ('code','paper_slip')),
  captured_at        timestamptz NOT NULL,        -- phone clock when sealed
  started_at         timestamptz,
  device_clock_at_upload timestamptz,             -- phone clock at upload, to measure clock drift
  lat                numeric(9,6),
  lng                numeric(9,6),
  gps_accuracy_m     numeric(8,1),
  gps_note           text,
  clerk_user_id      uuid NOT NULL REFERENCES users(id),
  received_at        timestamptz NOT NULL DEFAULT now(),
  flags              jsonb NOT NULL DEFAULT '[]', -- [{code, detail, severity}]
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','held','rejected')),
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  review_note        text,
  ai_check           jsonb,                       -- what the AI read off the scale and moisture photos
  UNIQUE (device_id, device_seq),
  CHECK (reviewed_by IS NULL OR reviewed_by <> clerk_user_id)    -- the clerk never accepts their own delivery
);
CREATE INDEX intakes_status_idx ON intakes (status, received_at DESC);
CREATE INDEX intakes_farmer_idx ON intakes (farmer_id);
CREATE INDEX intakes_wh_idx ON intakes (warehouse_id, captured_at DESC);

CREATE TABLE intake_photos (
  intake_id   uuid NOT NULL REFERENCES intakes(id),
  idx         smallint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('scale','moisture','bags','slip','other')),
  file_id     uuid NOT NULL REFERENCES files(id),
  sha256      text NOT NULL,
  PRIMARY KEY (intake_id, idx)
);

-- Captured facts are frozen once uploaded. Only the review fields, flags and the AI reading may change.
CREATE FUNCTION intakes_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','reviewed_by','reviewed_at','review_note','flags','ai_check'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reviewed_by','reviewed_at','review_note','flags','ai_check']) THEN
    RAISE EXCEPTION 'intake % is sealed: captured facts cannot be changed', OLD.ref;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER intakes_freeze BEFORE UPDATE ON intakes FOR EACH ROW EXECUTE FUNCTION intakes_freeze();
CREATE TRIGGER intakes_no_delete BEFORE DELETE ON intakes FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER intake_photos_frozen BEFORE UPDATE OR DELETE ON intake_photos FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check CHECK (purpose IN ('farmer_phone','farmer_consent','login_sms','intake_confirm'));
