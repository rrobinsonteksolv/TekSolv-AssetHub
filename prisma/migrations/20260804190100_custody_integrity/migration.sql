-- ============================================================================
-- Custody is single-holder.  (BUILD_SPEC §3.3)
--
-- An asset is in exactly one of: general stock, assigned to a person, staged
-- on a truck, or out on rent to a customer. Those states are mutually
-- exclusive, so the database refuses any row that claims two of them — the
-- invariant does not depend on every future code path remembering it.
--
-- Note what is deliberately NOT forbidden: an asset staged on a truck may sit
-- in IN_MAINTENANCE or OUT_OF_SERVICE. That is the "pulled from Truck 165"
-- case, and it is precisely what drops a truck's readiness on the dashboard.
-- Only OUT_ON_RENT clears custody.
-- ============================================================================

ALTER TABLE "Asset"
  ADD CONSTRAINT asset_custody_single_holder CHECK (
    (
      "custodyType" IS NULL
      AND "custodyUserId" IS NULL
      AND "custodyTruckId" IS NULL
    )
    OR (
      "custodyType" = 'PERSON'
      AND "custodyUserId" IS NOT NULL
      AND "custodyTruckId" IS NULL
    )
    OR (
      "custodyType" = 'TRUCK'
      AND "custodyTruckId" IS NOT NULL
      AND "custodyUserId" IS NULL
    )
  );

-- Custody is an act by a person; it always records who did it and when.
ALTER TABLE "Asset"
  ADD CONSTRAINT asset_custody_attributed CHECK (
    "custodyType" IS NULL
    OR ("custodyAssignedById" IS NOT NULL AND "custodyAssignedAt" IS NOT NULL)
  );

-- A unit out on rent to a customer holds no person/truck assignment.
ALTER TABLE "Asset"
  ADD CONSTRAINT asset_rent_clears_custody CHECK (
    "status" <> 'OUT_ON_RENT' OR "custodyType" IS NULL
  );

-- The custody history mirrors the same shape (NULL type = returned to stock).
ALTER TABLE "CustodyEvent"
  ADD CONSTRAINT custody_event_single_holder CHECK (
    (
      "type" IS NULL
      AND "userId" IS NULL
      AND "truckId" IS NULL
    )
    OR (
      "type" = 'PERSON'
      AND "userId" IS NOT NULL
      AND "truckId" IS NULL
    )
    OR (
      "type" = 'TRUCK'
      AND "truckId" IS NOT NULL
      AND "userId" IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Counted stock can never go negative, however the decrement is written.
-- ---------------------------------------------------------------------------
ALTER TABLE "Consumable"
  ADD CONSTRAINT consumable_on_hand_non_negative CHECK ("onHand" >= 0);

-- ---------------------------------------------------------------------------
-- assetTag is user-supplied and meaningful — never blank. (BUILD_SPEC §3.1)
-- There is no DEFAULT on this column anywhere by design; this makes an empty
-- string just as impossible as a NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE "Asset"
  ADD CONSTRAINT asset_tag_not_blank CHECK (length(btrim("assetTag")) > 0);
