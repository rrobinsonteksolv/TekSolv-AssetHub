-- ============================================================================
-- Form CAL-01 — Calibration Report.
--
-- The gas-monitor counterpart to FP-01: a calibration logged against a unit
-- generates a printed report the same way an inspection does. Three additions,
-- all nullable, all inert until a calibration is actually logged.
--
-- 1. WHAT IS IN THE CYLINDER (Consumable.gasType, .concentration).
--    CAL-01's gas table asks for gas type and concentration, and neither is
--    derivable from an item called "H2S cal gas (34L)" without parsing a name
--    somebody is free to rename. Free text rather than a parsed quantity:
--    "50 PPM", "2.5% vol" and "20.9%" all appear on real cylinder labels, and
--    a report that normalized what the label says would be worse than one that
--    copied it. Lot number and expiry are NOT duplicated here — those belong
--    to the lot, which already carries them.
--
-- 2. WHAT THE REPORT SAYS (MaintenanceRecord.calibration).
--    A snapshot, and the one place in this schema where that is right. The
--    report asserts that on this date this unit was calibrated with cylinder
--    lot 4417-B expiring 2027-02-28 and is next due on a date. Rendering that
--    live would let a corrected expiry, or a re-intervalled schedule, silently
--    rewrite a document somebody has already signed and filed.
--
-- 3. WHY THE GAS LEFT THE SHELF (ConsumableTxnReason.CALIBRATION).
--    Calibrating burns cal gas. That consumption goes through the ledger like
--    every other movement — same rule as every other write in this area — but
--    a cylinder burned calibrating a monitor is not a GRAB and recording it as
--    one would make the movement report lie about where the stock went.
-- ============================================================================

-- --- 1. What is in the cylinder ---------------------------------------------
ALTER TABLE "Consumable" ADD COLUMN IF NOT EXISTS "gasType" TEXT;
ALTER TABLE "Consumable" ADD COLUMN IF NOT EXISTS "concentration" TEXT;

-- --- 2. What the report says -------------------------------------------------
ALTER TABLE "MaintenanceRecord" ADD COLUMN IF NOT EXISTS "calibration" JSONB;

-- Every calibration report is reached from its unit's documents, so the index
-- that matters is the one already on ("orgId", "assetId"). This one answers the
-- other question — "show me the calibrations", i.e. the records that have a
-- report at all — without scanning the whole service history of the fleet.
CREATE INDEX IF NOT EXISTS "MaintenanceRecord_orgId_calibration_idx"
  ON "MaintenanceRecord"("orgId", "performedAt")
  WHERE "calibration" IS NOT NULL;

-- --- 3. Why the gas left the shelf -------------------------------------------
-- Postgres refuses ALTER TYPE ... ADD VALUE inside a transaction block on
-- versions before 12, and Prisma runs each migration in one. IF NOT EXISTS
-- makes it safe to re-run; the value is additive, so nothing already recorded
-- changes meaning.
ALTER TYPE "ConsumableTxnReason" ADD VALUE IF NOT EXISTS 'CALIBRATION';
