-- ============================================================================
-- Supplies v2 — stock becomes per office, and lot-tracked items track lots.
--
-- Two changes, one migration, because they touch the same column.
--
-- PART A — per office.
--   "22 boxes of gloves" is not a fact anybody can act on if 20 are in New
--   Castle and 2 are in Oakdale and the crew asking is in Oakdale. So the
--   count, the reorder point, and the low-stock alert all move to
--   ConsumableStock, one row per (item, office). `Consumable.onHand` and
--   `Consumable.reorderPoint` are DROPPED rather than kept as a mirror: a
--   fleet-wide total that is true of nowhere anybody stands is worse than no
--   number, and two places a count can live is exactly the drift this area is
--   built to avoid. The total still exists — it is the sum, computed where a
--   total is genuinely what is wanted.
--
-- PART B — lots.
--   An expired cal gas cylinder reads exactly like a good one on a shelf and
--   produces a calibration saying a monitor is fine when it is not. Lot-tracked
--   items therefore hold their stock as dated batches: consumption takes the
--   soonest-expiring first, and an expired lot stops counting as issuable.
--   Optional per item — gloves stay a number on a shelf.
--
-- The existing counts are moved, not discarded. Each org's stores location
-- takes them: a WAREHOUSE if the org has one, else its first active location.
-- No ledger rows are invented for the move — those counts had no ledger behind
-- them before this migration either, and writing fake movements to make the
-- books look tidy would be the one dishonest thing available here.
-- ============================================================================

-- --- Consumable: no count of its own; gains the lot-tracking flags ----------
ALTER TABLE "Consumable" ADD COLUMN IF NOT EXISTS "lotTracked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Consumable" ADD COLUMN IF NOT EXISTS "expiryLeadDays" INTEGER NOT NULL DEFAULT 30;

-- --- Per-office stock -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ConsumableStock" (
    "id"           TEXT NOT NULL,
    "orgId"        TEXT NOT NULL,
    "consumableId" TEXT NOT NULL,
    "locationId"   TEXT NOT NULL,
    "onHand"       INTEGER NOT NULL DEFAULT 0,
    "reorderPoint" INTEGER,
    "alertedAt"    TIMESTAMP(3),
    "alertedState" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsumableStock_pkey" PRIMARY KEY ("id")
);

-- --- Dated batches, for lot-tracked items only ------------------------------
CREATE TABLE IF NOT EXISTS "ConsumableLot" (
    "id"           TEXT NOT NULL,
    "orgId"        TEXT NOT NULL,
    "consumableId" TEXT NOT NULL,
    "locationId"   TEXT NOT NULL,
    "lotNumber"    TEXT NOT NULL,
    "expiresAt"    TIMESTAMP(3),
    "quantity"     INTEGER NOT NULL DEFAULT 0,
    "receivedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alertedAt"    TIMESTAMP(3),
    "alertedState" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsumableLot_pkey" PRIMARY KEY ("id")
);

-- --- The ledger records where, and which lot --------------------------------
ALTER TABLE "ConsumableTxn" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
ALTER TABLE "ConsumableTxn" ADD COLUMN IF NOT EXISTS "lotId" TEXT;

-- --- A worker's home office -------------------------------------------------
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "homeLocationId" TEXT;

-- --- Keys and indexes -------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "ConsumableStock_orgId_consumableId_locationId_key"
  ON "ConsumableStock"("orgId", "consumableId", "locationId");
CREATE INDEX IF NOT EXISTS "ConsumableStock_orgId_locationId_idx"
  ON "ConsumableStock"("orgId", "locationId");
CREATE INDEX IF NOT EXISTS "ConsumableStock_orgId_consumableId_idx"
  ON "ConsumableStock"("orgId", "consumableId");

CREATE UNIQUE INDEX IF NOT EXISTS "ConsumableLot_orgId_consumableId_locationId_lotNumber_key"
  ON "ConsumableLot"("orgId", "consumableId", "locationId", "lotNumber");
CREATE INDEX IF NOT EXISTS "ConsumableLot_orgId_consumableId_locationId_idx"
  ON "ConsumableLot"("orgId", "consumableId", "locationId");
CREATE INDEX IF NOT EXISTS "ConsumableLot_orgId_expiresAt_idx"
  ON "ConsumableLot"("orgId", "expiresAt");

CREATE INDEX IF NOT EXISTS "ConsumableTxn_orgId_locationId_idx"
  ON "ConsumableTxn"("orgId", "locationId");
CREATE INDEX IF NOT EXISTS "Membership_orgId_homeLocationId_idx"
  ON "Membership"("orgId", "homeLocationId");

DO $$
BEGIN
  ALTER TABLE "ConsumableStock"
    ADD CONSTRAINT "ConsumableStock_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE "ConsumableStock"
    ADD CONSTRAINT "ConsumableStock_consumableId_fkey" FOREIGN KEY ("consumableId")
    REFERENCES "Consumable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE "ConsumableStock"
    ADD CONSTRAINT "ConsumableStock_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TABLE "ConsumableLot"
    ADD CONSTRAINT "ConsumableLot_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE "ConsumableLot"
    ADD CONSTRAINT "ConsumableLot_consumableId_fkey" FOREIGN KEY ("consumableId")
    REFERENCES "Consumable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE "ConsumableLot"
    ADD CONSTRAINT "ConsumableLot_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TABLE "ConsumableTxn"
    ADD CONSTRAINT "ConsumableTxn_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE "ConsumableTxn"
    ADD CONSTRAINT "ConsumableTxn_lotId_fkey" FOREIGN KEY ("lotId")
    REFERENCES "ConsumableLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TABLE "Membership"
    ADD CONSTRAINT "Membership_homeLocationId_fkey" FOREIGN KEY ("homeLocationId")
    REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- The same non-negative guarantee, moved to where the count now lives ----
-- Both are the backstop behind the conditional decrements in the grab and
-- adjust paths, not a substitute for them: the application refuses the write
-- with a sentence, and this refuses it with an error if the application ever
-- stops.
DO $$
BEGIN
  ALTER TABLE "ConsumableStock"
    ADD CONSTRAINT consumable_stock_on_hand_non_negative CHECK ("onHand" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE "ConsumableLot"
    ADD CONSTRAINT consumable_lot_quantity_non_negative CHECK ("quantity" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- Move the counts we already have ----------------------------------------
-- Each org's stores location takes them: a WAREHOUSE if there is one, else the
-- first active location by name. An org with no locations at all has nowhere to
-- put stock and is skipped rather than guessed at — its items simply start
-- unstocked, which is true.
INSERT INTO "ConsumableStock" ("id", "orgId", "consumableId", "locationId", "onHand", "reorderPoint", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."orgId",
  c."id",
  stores."id",
  c."onHand",
  c."reorderPoint",
  CURRENT_TIMESTAMP
FROM "Consumable" c
JOIN LATERAL (
  SELECT l."id"
  FROM "Location" l
  WHERE l."orgId" = c."orgId" AND l."active"
  ORDER BY (l."type" = 'WAREHOUSE') DESC, l."name" ASC
  LIMIT 1
) stores ON TRUE
ON CONFLICT ("orgId", "consumableId", "locationId") DO NOTHING;

-- Ledger rows predating this all belong to that same stores location, for the
-- same reason: it is where the stock they moved actually was.
UPDATE "ConsumableTxn" t
SET "locationId" = s."locationId"
FROM "ConsumableStock" s
WHERE t."locationId" IS NULL
  AND s."consumableId" = t."consumableId"
  AND s."orgId" = t."orgId";

-- --- And retire the columns that used to hold the count ---------------------
ALTER TABLE "Consumable" DROP CONSTRAINT IF EXISTS consumable_on_hand_non_negative;
ALTER TABLE "Consumable" DROP COLUMN IF EXISTS "onHand";
ALTER TABLE "Consumable" DROP COLUMN IF EXISTS "reorderPoint";
