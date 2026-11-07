-- Build 2: registry, tiered identity checks, consent, lender verification, partner applications, SMS second step.

-- ---------- Files (ID photos, selfies, consent evidence): encrypted on disk, metadata here ----------
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('id_document','selfie','consent_evidence','warehouse_document','other')),
  path         text NOT NULL UNIQUE,                 -- relative to UPLOADS_DIR
  mime         text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0),
  sha256       text NOT NULL,                        -- of the plain file, for integrity
  entity       text NOT NULL,
  entity_id    uuid NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,                          -- content removed under the retention policy; the row stays
  delete_after date
);
CREATE INDEX files_entity_idx ON files (entity, entity_id);

-- ---------- Farmers ----------
-- kyc_level: 0 registered, 1 identity checked by Kitovu (maker-checker), 2 a lender has verified the person.
ALTER TABLE farmers
  ADD COLUMN kyc_level          smallint NOT NULL DEFAULT 0 CHECK (kyc_level IN (0,1,2)),
  ADD COLUMN phone_verified_at  timestamptz,
  ADD COLUMN id_type            text CHECK (id_type IN ('nin','voters_card','drivers_licence','intl_passport')),
  ADD COLUMN id_number_hash     text,               -- HMAC of the normalised number: finds duplicates, cannot be reversed
  ADD COLUMN id_last4           text CHECK (id_last4 ~ '^[0-9A-Z]{4}$'),
  ADD COLUMN photo_file_id      uuid REFERENCES files(id),
  ADD COLUMN registered_by_partner uuid REFERENCES field_partners(id),
  ADD COLUMN registered_by_user uuid REFERENCES users(id),
  ADD COLUMN year_of_birth      smallint CHECK (year_of_birth BETWEEN 1900 AND 2100);
CREATE UNIQUE INDEX farmers_id_number_uniq ON farmers (id_type, id_number_hash) WHERE id_number_hash IS NOT NULL AND status = 'active';
CREATE SEQUENCE farmer_code_seq START 200000;   -- legacy codes stay below this

CREATE TABLE kyc_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id        uuid NOT NULL REFERENCES farmers(id),
  id_type          text NOT NULL CHECK (id_type IN ('nin','voters_card','drivers_licence','intl_passport')),
  id_number_hash   text NOT NULL,
  id_last4         text NOT NULL,
  id_doc_file_id   uuid NOT NULL REFERENCES files(id),
  selfie_file_id   uuid NOT NULL REFERENCES files(id),
  phone_verified   boolean NOT NULL,
  submitted_by     uuid NOT NULL REFERENCES users(id),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_note      text,
  provider         text,                         -- external lookup used, if any
  provider_ref     text,
  provider_result  jsonb,
  CHECK (reviewed_by IS NULL OR reviewed_by <> submitted_by)   -- maker-checker
);
CREATE UNIQUE INDEX kyc_one_pending ON kyc_submissions (farmer_id) WHERE status = 'pending';

CREATE TABLE farmer_consents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id        uuid NOT NULL REFERENCES farmers(id),
  org_id           uuid NOT NULL REFERENCES organisations(id),
  purpose          text NOT NULL DEFAULT 'share_for_financing' CHECK (purpose IN ('share_for_financing')),
  method           text NOT NULL CHECK (method IN ('paper_form','voice_recording','sms_code','ussd')),
  evidence_file_id uuid REFERENCES files(id),
  given_at         timestamptz NOT NULL DEFAULT now(),
  recorded_by      uuid NOT NULL REFERENCES users(id),
  withdrawn_at     timestamptz,
  withdrawn_by     uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX farmer_consents_active ON farmer_consents (farmer_id, org_id, purpose) WHERE withdrawn_at IS NULL;

-- Level 2: the lender confirms it has opened an account for the farmer (so its own BVN/NIN checks are done).
-- Stores the lender's customer reference only: never an account number.
CREATE TABLE lender_verifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id      uuid NOT NULL REFERENCES farmers(id),
  org_id         uuid NOT NULL REFERENCES organisations(id),
  customer_ref   text NOT NULL CHECK (length(customer_ref) BETWEEN 3 AND 40),
  verified_by    uuid NOT NULL REFERENCES users(id),
  verified_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX lender_verifications_active ON lender_verifications (farmer_id, org_id) WHERE revoked_at IS NULL;

-- One-time codes (farmer phone checks, SMS second step). Only hashes are stored.
CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose     text NOT NULL CHECK (purpose IN ('farmer_phone','farmer_consent','login_sms')),
  subject_id  uuid NOT NULL,                     -- farmer or user
  phone_e164  text NOT NULL,
  code_hash   text NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX otp_codes_subject_idx ON otp_codes (purpose, subject_id, created_at DESC);

-- ---------- Field partners ----------
ALTER TABLE field_partners
  ADD COLUMN state_code   text REFERENCES states(code),
  ADD COLUMN community    text,
  ADD COLUMN user_id      uuid REFERENCES users(id),
  ADD COLUMN verified_at  timestamptz,
  ADD COLUMN verified_by  uuid REFERENCES users(id);
CREATE SEQUENCE field_partner_code_seq START 50000;

-- ---------- Warehouses ----------
ALTER TABLE warehouses
  ADD COLUMN commodities    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN contact_name   text,
  ADD COLUMN contact_phone  text CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

-- ---------- Public partner applications ----------
CREATE TABLE partner_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name      text NOT NULL,
  kind          org_kind NOT NULL CHECK (kind NOT IN ('kitovu','other')),
  contact_name  text NOT NULL,
  email         citext NOT NULL,
  phone_e164    text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  state_code    text REFERENCES states(code),
  details       jsonb NOT NULL DEFAULT '{}',
  message       text,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','rejected','spam')),
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  review_note   text,
  org_id        uuid REFERENCES organisations(id),
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- SMS second step for low-risk roles ----------
ALTER TABLE users ADD COLUMN second_factor text NOT NULL DEFAULT 'totp' CHECK (second_factor IN ('totp','sms'));
ALTER TABLE users ADD COLUMN sms_enrolled_at timestamptz;
