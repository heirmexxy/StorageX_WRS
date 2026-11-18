-- Lender watch: the value at storage on every receipt, the insurance policy that covered it at issue, alerts to
-- lenders and Kitovu (prices, sales, warehouse conditions), and WareGuard sensor data ready for Titan.

-- Value at storage and the insurance in force are facts of the receipt, fixed when it is issued.
ALTER TABLE receipts
  ADD COLUMN issue_kobo_per_kg   bigint CHECK (issue_kobo_per_kg > 0),
  ADD COLUMN issue_value_kobo    bigint CHECK (issue_value_kobo >= 0),
  ADD COLUMN issue_price         jsonb,          -- how the price was found: scope, state, window, observations
  ADD COLUMN insurance_policy_id uuid REFERENCES insurance_policies(id);

-- Alerts for an organisation's people (org_id NULL = Kitovu). One per key, so a job can run again safely.
CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organisations(id),
  kind        text NOT NULL CHECK (kind IN ('price_warning','margin_call','liquidation','price_drop','sale_proposed','sale_approved','sale_cancelled','sale_settled','warehouse_condition','warehouse_offline')),
  level       text NOT NULL CHECK (level IN ('info','warn','urgent')),
  title       text NOT NULL,
  body        text NOT NULL,
  link        text,
  dedupe_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  seen_by     uuid REFERENCES users(id),
  seen_at     timestamptz
);
CREATE UNIQUE INDEX alerts_once ON alerts (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key);
CREATE INDEX alerts_org_time ON alerts (org_id, created_at DESC);

-- WareGuard devices in warehouses, as Titan reports them.
CREATE TABLE sensor_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  device_ref    text NOT NULL UNIQUE,              -- Titan's id for the device
  label         text NOT NULL,                     -- e.g. "Bay 2, north wall"
  kinds         text[] NOT NULL DEFAULT '{temperature,humidity}',
  active        boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sensor_readings (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES sensor_devices(id),
  at           timestamptz NOT NULL,
  temp_c       numeric(5,2),
  rh_pct       numeric(5,2) CHECK (rh_pct BETWEEN 0 AND 100),
  door_open    boolean,
  battery_pct  numeric(5,2),
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, at)
);
CREATE INDEX sensor_readings_device_time ON sensor_readings (device_id, at DESC);
CREATE TRIGGER sensor_readings_append_only BEFORE UPDATE OR DELETE ON sensor_readings FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A condition outside safe limits, open while it lasts. The explainer's advice is kept with it.
CREATE TABLE sensor_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  device_id     uuid REFERENCES sensor_devices(id),
  kind          text NOT NULL CHECK (kind IN ('high_temperature','high_humidity','door_open','offline')),
  severity      text NOT NULL CHECK (severity IN ('warn','urgent')),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  peak          numeric(7,2),
  advice        jsonb,                             -- what is happening and what to do (wareguard-explainer)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sensor_alerts_one_open ON sensor_alerts (COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid), warehouse_id, kind) WHERE ended_at IS NULL;
