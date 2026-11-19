-- Titan connection: StorageX reads WareGuard data from Titan's API with a key issued by Titan, and Titan tells
-- StorageX of new readings, alerts and device changes by signed webhook.

-- Which Titan site is which warehouse. Matched by the site's external reference (the warehouse code), its name, or set
-- by hand on the warehouse page.
ALTER TABLE warehouses ADD COLUMN titan_site_id text UNIQUE;
ALTER TABLE warehouses ADD COLUMN titan_synced_to timestamptz;     -- readings fetched up to this time

-- The webhook subscription StorageX made on Titan; its signing secret is kept encrypted.
CREATE TABLE titan_link (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  webhook_id    text,
  secret_enc    text,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_sync_at  timestamptz,
  last_result   jsonb
);

-- Alerts Titan raises that StorageX does not measure itself (tamper, intruder, power lost, sensor error).
ALTER TABLE sensor_alerts DROP CONSTRAINT sensor_alerts_kind_check;
ALTER TABLE sensor_alerts ADD CONSTRAINT sensor_alerts_kind_check CHECK (kind IN ('high_temperature','high_humidity','door_open','offline','tamper','intruder','power_lost','sensor_error'));
ALTER TABLE sensor_alerts ADD COLUMN titan_alert_id text UNIQUE;
