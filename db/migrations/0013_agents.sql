-- Build 11: the intake inspector (checks each delivery against history, holds suspicious ones) and the data
-- steward (keeps the registry clean, files and closes its own data issues).

-- A delivery with a serious flag needs compliance to clear it before operations can accept it: two people, two
-- roles. The inspector's findings are kept with the record.
ALTER TABLE intakes
  ADD COLUMN inspection       jsonb,
  ADD COLUMN hold_cleared_by  uuid REFERENCES users(id),
  ADD COLUMN hold_cleared_at  timestamptz,
  ADD COLUMN hold_clear_note  text,
  ADD CONSTRAINT intakes_clearer_not_clerk CHECK (hold_cleared_by IS NULL OR hold_cleared_by <> clerk_user_id),
  ADD CONSTRAINT intakes_holds_cleared CHECK (status <> 'accepted' OR hold_cleared_by IS NOT NULL
    OR NOT jsonb_path_exists(flags, '$[*] ? (@.severity == "hold")')) NOT VALID;

CREATE OR REPLACE FUNCTION intakes_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['status','reviewed_by','reviewed_at','review_note','flags','ai_check','inspection','hold_cleared_by','hold_cleared_at','hold_clear_note'];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'intake % is sealed: captured facts cannot be changed', OLD.ref;
  END IF;
  -- A clearance, once given, stays on the record.
  IF OLD.hold_cleared_by IS NOT NULL AND NEW.hold_cleared_by IS DISTINCT FROM OLD.hold_cleared_by THEN
    RAISE EXCEPTION 'intake %: the hold clearance cannot be changed', OLD.ref;
  END IF;
  RETURN NEW;
END $$;
CREATE INDEX intake_photos_sha_idx ON intake_photos (sha256);
CREATE INDEX intakes_farmer_time_idx ON intakes (farmer_id, captured_at);
CREATE INDEX intakes_clerk_time_idx ON intakes (clerk_user_id, captured_at);

-- Issues the data steward finds are its own: it opens one per problem and closes it when the problem is gone.
ALTER TABLE data_issues
  ADD COLUMN source         text NOT NULL DEFAULT 'import' CHECK (source IN ('import','steward','manual')),
  ADD COLUMN first_seen_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN resolved_note  text;
CREATE UNIQUE INDEX data_issues_steward_open ON data_issues (entity, entity_id, code) WHERE source = 'steward' AND resolved_at IS NULL;

CREATE TABLE steward_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  opened      int NOT NULL DEFAULT 0,
  closed      int NOT NULL DEFAULT 0,
  still_open  int NOT NULL DEFAULT 0,
  by_code     jsonb NOT NULL DEFAULT '{}',
  started_by  text NOT NULL
);
