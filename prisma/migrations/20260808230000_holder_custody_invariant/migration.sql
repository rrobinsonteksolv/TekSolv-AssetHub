-- The single-holder invariant, extended to holder-locations.
--
-- BUILD_SPEC §3.3 says a unit has exactly one holder. Adding a third kind of
-- holder without extending this constraint would have left the rule enforced
-- for two of the three — and the one that got through would be the one nobody
-- was checking. It stays a database rule rather than a convention in the
-- assignment helper, so no future code path can violate it.

ALTER TABLE "CustodyEvent" ADD COLUMN "locationId" TEXT;

ALTER TABLE "CustodyEvent"
  ADD CONSTRAINT "CustodyEvent_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Asset" DROP CONSTRAINT asset_custody_single_holder;

ALTER TABLE "Asset"
  ADD CONSTRAINT asset_custody_single_holder CHECK (
    (
      "custodyType" IS NULL
      AND "custodyUserId" IS NULL
      AND "custodyTruckId" IS NULL
      AND "custodyLocationId" IS NULL
    )
    OR (
      "custodyType" = 'PERSON'
      AND "custodyUserId" IS NOT NULL
      AND "custodyTruckId" IS NULL
      AND "custodyLocationId" IS NULL
    )
    OR (
      "custodyType" = 'TRUCK'
      AND "custodyTruckId" IS NOT NULL
      AND "custodyUserId" IS NULL
      AND "custodyLocationId" IS NULL
    )
    OR (
      "custodyType" = 'LOCATION'
      AND "custodyLocationId" IS NOT NULL
      AND "custodyUserId" IS NULL
      AND "custodyTruckId" IS NULL
    )
  );

-- The history mirrors the same shape.
ALTER TABLE "CustodyEvent" DROP CONSTRAINT custody_event_single_holder;

ALTER TABLE "CustodyEvent"
  ADD CONSTRAINT custody_event_single_holder CHECK (
    ("type" IS NULL AND "userId" IS NULL AND "truckId" IS NULL AND "locationId" IS NULL)
    OR ("type" = 'PERSON' AND "userId" IS NOT NULL AND "truckId" IS NULL AND "locationId" IS NULL)
    OR ("type" = 'TRUCK' AND "truckId" IS NOT NULL AND "userId" IS NULL AND "locationId" IS NULL)
    OR ("type" = 'LOCATION' AND "locationId" IS NOT NULL AND "userId" IS NULL AND "truckId" IS NULL)
  );
