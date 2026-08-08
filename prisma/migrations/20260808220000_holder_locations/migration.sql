-- Holder locations: a named place that holds gear, in the same exclusive set
-- as a person and a truck.
--
-- "Ops Manager Office" and "Rescue Prop" are holders in exactly the sense a
-- truck is: gear is assigned to them, one holder at a time, and the assignment
-- is worth a CustodyEvent because "who had it last" has to answer the same way
-- whichever kind of holder it was.
--
-- Deliberately NOT the same column as `locationId`. That one is where a unit is
-- catalogued; this is what currently holds it. A unit can be catalogued at the
-- warehouse and assigned to the Rescue Prop, and collapsing the two would make
-- "where does this live" and "where is this now" the same question — which is
-- the confusion custody exists to resolve.

ALTER TYPE "CustodyType" ADD VALUE 'LOCATION';

ALTER TABLE "Asset" ADD COLUMN "custodyLocationId" TEXT;

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_custodyLocationId_fkey" FOREIGN KEY ("custodyLocationId")
    REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Asset_orgId_custodyLocationId_idx" ON "Asset"("orgId", "custodyLocationId");
