-- Build 5: stock control. Stacks, an append-only stock ledger, withdrawals (releases) against receipts,
-- adjustments with a second approver, physical counts, and reconciliation against receipts.

CREATE TABLE stacks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  code           text NOT NULL,                     -- as painted on the stack card, e.g. B2-S1
  commodity_code text NOT NULL REFERENCES commodities(code),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  note           text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code)
);

-- Every kilo in or out of a warehouse. Balances are sums; nothing is ever edited.
CREATE TABLE stock_moves (
  id             bigserial PRIMARY KEY,
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  commodity_code text NOT NULL REFERENCES commodities(code),
  stack_id       uuid REFERENCES stacks(id),        -- NULL = not yet placed on a stack
  kind           text NOT NULL CHECK (kind IN ('in','out','transfer_out','transfer_in','adjust')),
  kg             numeric(14,2) NOT NULL CHECK (kg <> 0),
  bags           integer NOT NULL DEFAULT 0,
  ref_type       text NOT NULL CHECK (ref_type IN ('intake','release','transfer','adjustment','opening')),
  ref_id         uuid,
  note           text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('in','transfer_in') AND kg > 0) OR (kind IN ('out','transfer_out') AND kg < 0) OR kind = 'adjust')
);
CREATE INDEX stock_moves_wh_idx ON stock_moves (warehouse_id, commodity_code);
CREATE INDEX stock_moves_stack_idx ON stock_moves (stack_id);
CREATE UNIQUE INDEX stock_moves_one_intake ON stock_moves (ref_id) WHERE ref_type = 'intake';
CREATE TRIGGER stock_moves_append_only BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Deliveries already accepted before this build go in as unplaced stock.
INSERT INTO stock_moves (warehouse_id, commodity_code, stack_id, kind, kg, bags, ref_type, ref_id, note, created_by, created_at)
SELECT warehouse_id, commodity_code, NULL, 'in', net_kg, bags, 'intake', id, 'accepted before stock control', reviewed_by, COALESCE(reviewed_at, received_at)
FROM intakes WHERE status = 'accepted';

-- Withdrawals against a receipt: ordered by Kitovu, loaded and weighed out at the gate by someone else.
CREATE TABLE releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text NOT NULL UNIQUE,             -- REL-<yymmdd>-<seq>
  receipt_id      uuid NOT NULL REFERENCES receipts(id),
  kg_ordered      numeric(14,2) NOT NULL CHECK (kg_ordered > 0),
  kg_loaded       numeric(14,2) CHECK (kg_loaded > 0),
  bags_loaded     integer CHECK (bags_loaded > 0),
  stack_id        uuid REFERENCES stacks(id),
  status          text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','loaded','cancelled')),
  reason          text NOT NULL CHECK (reason IN ('owner_withdrawal','sale_delivery','lender_enforcement','other')),
  collector_name  text,
  collector_phone text,
  ordered_by      uuid NOT NULL REFERENCES users(id),
  ordered_at      timestamptz NOT NULL DEFAULT now(),
  loaded_by       uuid REFERENCES users(id),
  loaded_at       timestamptz,
  scale_photo_id  uuid REFERENCES files(id),
  slip_photo_id   uuid REFERENCES files(id),
  note            text,
  CHECK (loaded_by IS NULL OR loaded_by <> ordered_by)     -- the person who orders never loads
);
CREATE INDEX releases_receipt_idx ON releases (receipt_id);

-- What is still held against each receipt.
CREATE VIEW receipt_balances AS
SELECT r.id AS receipt_id, r.net_weight_kg,
       COALESCE((SELECT sum(kg_loaded) FROM releases x WHERE x.receipt_id = r.id AND x.status = 'loaded'), 0) AS released_kg,
       r.net_weight_kg - COALESCE((SELECT sum(kg_loaded) FROM releases x WHERE x.receipt_id = r.id AND x.status = 'loaded'), 0) AS remaining_kg
FROM receipts r;

-- Shrinkage, damage, recount corrections: proposed by one person, approved by a Kitovu person.
CREATE TABLE stock_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  stack_id       uuid NOT NULL REFERENCES stacks(id),
  kg             numeric(14,2) NOT NULL CHECK (kg <> 0),
  bags           integer NOT NULL DEFAULT 0,
  reason         text NOT NULL CHECK (reason IN ('moisture_loss','pest_damage','spillage','theft','recount_correction','other')),
  note           text NOT NULL,
  photo_id       uuid REFERENCES files(id),
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  proposed_by    uuid NOT NULL REFERENCES users(id),
  proposed_at    timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);

-- Physical counts of a stack: bags counted, a sample of bags weighed, photo of the stack card.
CREATE TABLE stock_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  stack_id       uuid NOT NULL REFERENCES stacks(id),
  bags_counted   integer NOT NULL CHECK (bags_counted >= 0),
  sample_bags    integer CHECK (sample_bags > 0),
  sample_kg      numeric(10,2) CHECK (sample_kg > 0),
  est_kg         numeric(14,2) NOT NULL CHECK (est_kg >= 0),
  book_kg        numeric(14,2) NOT NULL,            -- ledger balance at the moment of the count
  book_bags      integer NOT NULL,
  photo_id       uuid REFERENCES files(id),
  counted_by     uuid NOT NULL REFERENCES users(id),
  counted_at     timestamptz NOT NULL DEFAULT now(),
  note           text
);
CREATE INDEX stock_counts_stack_idx ON stock_counts (stack_id, counted_at DESC);
CREATE TRIGGER stock_counts_append_only BEFORE UPDATE OR DELETE ON stock_counts FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('id_document','selfie','consent_evidence','warehouse_document','intake_evidence','stock_evidence','other'));
