-- Retirement as a recorded fact, not just a status.
--
-- OUT_OF_SERVICE is temporary — the unit is coming back. RETIRED is permanent,
-- and the *reason* is the part worth keeping: "sold" and "damaged beyond
-- repair" are the same row in inventory and completely different facts about
-- how the fleet is being run.

CREATE TYPE "RetirementReason" AS ENUM (
  'SOLD',
  'SCRAPPED',
  'DAMAGED_BEYOND_REPAIR',
  'LOST',
  'OTHER'
);

ALTER TABLE "Asset"
  ADD COLUMN "retiredAt"     TIMESTAMP(3),
  ADD COLUMN "retiredReason" "RetirementReason",
  ADD COLUMN "retiredNote"   TEXT,
  ADD COLUMN "retiredById"   TEXT;

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_retiredById_fkey" FOREIGN KEY ("retiredById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Asset_orgId_retiredAt_idx" ON "Asset"("orgId", "retiredAt");

-- The two states cannot disagree.
--
-- A retired unit must carry its disposition, and a unit that is not retired
-- must not: without this, "retire" and "un-retire" are two independent writes
-- that can each half-succeed, and the Retired list ends up showing units with
-- no reason beside units that are back in service.
ALTER TABLE "Asset" ADD CONSTRAINT "asset_retirement_is_complete" CHECK (
  (
    "status" = 'RETIRED'
    AND "active" = false
    AND "retiredAt" IS NOT NULL
    AND "retiredReason" IS NOT NULL
  )
  OR (
    "status" <> 'RETIRED'
    AND "retiredAt" IS NULL
    AND "retiredReason" IS NULL
  )
);
