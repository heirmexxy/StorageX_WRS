-- Build 10: farmers know what is happening without calling. One place sends every text to a farmer, from
-- templates Kitovu can translate (a second person approves each wording before it is used), every message is
-- logged, and a USSD menu answers "what do I have, what do I owe, what have I been paid" on any phone.

ALTER TABLE farmers
  ADD COLUMN language          text NOT NULL DEFAULT 'en' CHECK (language IN ('en','pcm','ha','yo','ig')),
  ADD COLUMN sms_reminders     boolean NOT NULL DEFAULT true,       -- due-date reminders; event texts always go
  ADD COLUMN ussd_pin_hash     text,
  ADD COLUMN ussd_pin_set_at   timestamptz,
  ADD COLUMN ussd_failed       smallint NOT NULL DEFAULT 0,
  ADD COLUMN ussd_locked_until timestamptz;

-- Wording of each farmer message, per language. A draft becomes live only when someone other than its author
-- approves it; the previous live wording is kept (retired) for the record.
CREATE TABLE message_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event        text NOT NULL,
  language     text NOT NULL CHECK (language IN ('en','pcm','ha','yo','ig')),
  body         text NOT NULL CHECK (length(body) BETWEEN 10 AND 459),   -- at most three SMS parts
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','retired','rejected')),
  proposed_by  uuid REFERENCES users(id),                               -- null = shipped with StorageX
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  CHECK (decided_by IS NULL OR proposed_by IS NULL OR decided_by <> proposed_by),
  CHECK (status = 'draft' OR proposed_by IS NULL OR decided_by IS NOT NULL)
);
CREATE UNIQUE INDEX message_templates_one_live ON message_templates (event, language) WHERE status = 'live';
CREATE UNIQUE INDEX message_templates_one_draft ON message_templates (event, language) WHERE status = 'draft';

-- Every message to a farmer, sent or not. (event, ref) stops the same message going twice.
CREATE TABLE farmer_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id   uuid NOT NULL REFERENCES farmers(id),
  event       text NOT NULL,
  ref         text NOT NULL,
  channel     text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms')),
  language    text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX farmer_messages_once ON farmer_messages (farmer_id, event, ref) WHERE status = 'sent';
CREATE INDEX farmer_messages_farmer ON farmer_messages (farmer_id, created_at DESC);
CREATE TRIGGER farmer_messages_append_only BEFORE UPDATE OR DELETE ON farmer_messages FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- What farmers did on USSD: which menu, never the PIN or the raw keypad text.
CREATE TABLE ussd_log (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL,
  phone_hash  text NOT NULL,
  farmer_id   uuid REFERENCES farmers(id),
  screen      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ussd_log_farmer ON ussd_log (farmer_id, created_at DESC);
CREATE TRIGGER ussd_log_append_only BEFORE UPDATE OR DELETE ON ussd_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- "Call me back" from USSD, worked by Kitovu operations.
CREATE TABLE farmer_callbacks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id    uuid NOT NULL REFERENCES farmers(id),
  topic        text NOT NULL CHECK (topic IN ('receipt','loan','payment','pin','other')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_by   uuid REFERENCES users(id),
  handled_at   timestamptz,
  note         text
);
CREATE UNIQUE INDEX farmer_callbacks_one_open ON farmer_callbacks (farmer_id, topic) WHERE handled_at IS NULL;
