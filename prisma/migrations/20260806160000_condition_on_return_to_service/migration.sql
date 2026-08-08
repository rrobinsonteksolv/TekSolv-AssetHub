-- ============================================================================
-- Repair the units this bug already left contradicting themselves.
--
-- Returning a unit to service moved its status and left its condition alone, so
-- a monitor that came back from a customer damaged, went out of service, was
-- repaired and was put back on the shelf ended up reading AVAILABLE / DAMAGED.
-- Those two statements cannot both be true: the first says anybody may take it
-- out on a job, the second says it is broken, and the condition is what a tech
-- reads before signing for it.
--
-- The code fix is upstream — every return-to-service path now asks what
-- condition the unit is in and writes it with the status flip, in the same
-- write. This is only the cleanup behind it.
--
-- GOOD is chosen for the same reason the fixed code defaults to it: somebody
-- decided this unit was fit to hand out, so the stale half of the contradiction
-- is the condition, not the status. That is a repair of a known bug's output,
-- **not** an assertion about the physical unit — anyone who knows better should
-- correct it on the unit's page, and from now on the person doing the repair is
-- asked at the moment they would know.
--
-- Deliberately narrow:
--   • OUT_OF_SERVICE / IN_MAINTENANCE are left alone — damaged and in the shop
--     is the pair this whole flow exists to express, and it is consistent.
--   • RETIRED is left alone — "damaged" is frequently *why* a unit was retired,
--     and rewriting that would erase the reason it left the fleet.
--   • OUT_ON_RENT is included: a unit can only reach it from AVAILABLE, so a
--     damaged one out on a job got there carrying this same stale label.
-- ============================================================================

UPDATE "Asset"
SET "condition" = 'GOOD', "updatedAt" = CURRENT_TIMESTAMP
WHERE "condition" = 'DAMAGED'
  AND "status" IN ('AVAILABLE', 'OUT_ON_RENT');
