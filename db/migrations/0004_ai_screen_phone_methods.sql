-- Build 2.1: other ways to confirm a farmer's phone, and the AI pre-check on identity submissions.

-- How the farmer's phone (or, without one, their presence) was confirmed.
--   sms       code by text message
--   voice     code read out by an automated call (works on any phone, helps low literacy)
--   attested  no usable phone or no signal: the field partner and a named local witness vouch in person
ALTER TABLE farmers
  ADD COLUMN phone_check_method text CHECK (phone_check_method IN ('sms','voice','attested')),
  ADD COLUMN phone_attestation  jsonb;     -- witness name, role, phone; recorded by; note
UPDATE farmers SET phone_check_method = 'sms' WHERE phone_verified_at IS NOT NULL;

ALTER TABLE otp_codes ADD COLUMN channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','voice'));
ALTER TABLE kyc_submissions ADD COLUMN phone_check_method text;

-- The AI pre-check: reads the two photos and the record, reports findings for the human reviewer.
-- It never approves or rejects, and it does not judge whether two faces are the same person.
CREATE TABLE kyc_ai_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES kyc_submissions(id),
  status         text NOT NULL CHECK (status IN ('done','failed','skipped')),
  model          text,
  prompt_version text NOT NULL,
  result         jsonb,                   -- structured findings (see src/lib/agents/kyc-screen.ts)
  flag           text CHECK (flag IN ('green','amber','red')),
  error          text,
  tokens_in      integer,
  tokens_out     integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_ai_checks_sub_idx ON kyc_ai_checks (submission_id, created_at DESC);

-- How the human decision compared with the AI flag, so its accuracy can be measured before trusting it more.
ALTER TABLE kyc_submissions ADD COLUMN ai_flag text, ADD COLUMN reviewer_agreed_with_ai boolean;

-- Platform settings changed from the admin screen (not the server file), each change audited.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
