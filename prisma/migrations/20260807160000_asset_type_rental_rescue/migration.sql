-- ============================================================================
-- RENTAL vs RESCUE.
--
-- What a unit is *for*, which is a different question from where it is
-- (status) or what it is (category). Rental gear earns money and belongs in
-- utilization. Rescue gear is standing capability: it lives on a truck waiting
-- for a callout, and counting it as idle rental stock drags utilization down
-- with equipment that was never meant to go out on a ticket — 41 rescue items
-- on one truck would read as a 41-unit hole in the numbers.
--
-- Deliberately orthogonal to custody. Both kinds are staged on trucks, and a
-- truck's loadout is everything on it; only the rental and utilization reports
-- filter on this.
--
-- Defaulting to RENTAL is the safe direction: a rental unit mis-marked as
-- rescue disappears from reports quietly, whereas the reverse shows up
-- somewhere a person will notice.
-- ============================================================================

DO $$
BEGIN
  CREATE TYPE "AssetType" AS ENUM ('RENTAL', 'RESCUE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Asset"
  ADD COLUMN IF NOT EXISTS "assetType" "AssetType" NOT NULL DEFAULT 'RENTAL';

CREATE INDEX IF NOT EXISTS "Asset_orgId_assetType_idx" ON "Asset"("orgId", "assetType");
