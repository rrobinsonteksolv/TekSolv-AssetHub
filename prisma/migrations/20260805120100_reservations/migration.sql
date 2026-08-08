-- ============================================================================
-- Phase 4b, part 2 of 2: reservations reserve the window. (BUILD_SPEC §6.6)
--
-- A reservation is a Rental in the RESERVED state carrying a future tstzrange.
-- The whole point of §6.6 is that this is NOT a flag on the asset: a reserved
-- unit is still physically AVAILABLE today, and may go out on a short rental
-- that returns before the reservation starts. So the only thing that has to
-- change for reservations to be real is *which statuses hold the window* — and
-- that lives in the exclusion constraint, not in application code.
--
-- Everything below is a rewrite of 20260804190000_reservation_integrity with
-- 'RESERVED' added to the three places that enumerate the holding statuses.
-- ============================================================================

-- No-show: stamped by the notification cron when a reservation's start passes
-- with the unit still on the shelf. Nullable by design — an un-stamped row is
-- simply one that has not come due yet, and clearing it on pickup is how a
-- late-but-collected reservation stops being flagged.
ALTER TABLE "Rental" ADD COLUMN IF NOT EXISTS "noShowAt" TIMESTAMP(3);

-- The reservation board reads forwards from today, ordered by start date;
-- every other Rental index is keyed on expectedReturnDate, which is the wrong
-- end of the window for this screen.
CREATE INDEX IF NOT EXISTS "Rental_orgId_checkoutDate_idx"
  ON "Rental" ("orgId", "checkoutDate");

-- ---------------------------------------------------------------------------
-- The exclusion constraint. RESERVED joins OPEN and OVERDUE as a status that
-- holds the asset for its window; RETURNED and CANCELLED still hold nothing,
-- which is what makes "cancel" free the window immediately.
-- ---------------------------------------------------------------------------
ALTER TABLE "Rental" DROP CONSTRAINT IF EXISTS rental_no_overlap;

ALTER TABLE "Rental"
  ADD CONSTRAINT rental_no_overlap
  EXCLUDE USING gist (
    "assetId" WITH =,
    period    WITH &&
  )
  WHERE (status IN ('OPEN', 'OVERDUE', 'RESERVED'));

DROP INDEX IF EXISTS rental_period_gist;
CREATE INDEX rental_period_gist
  ON "Rental" USING gist (period)
  WHERE status IN ('OPEN', 'OVERDUE', 'RESERVED');

-- ---------------------------------------------------------------------------
-- The deferred trigger closes the same loophole for reservations that it
-- closes for checkouts: a NULL period overlaps nothing, so a RESERVED row
-- without a window would reserve nothing at all while looking, on every
-- screen, exactly like a booking. Prisma cannot write a tstzrange, so a
-- reservation is necessarily two statements (INSERT, then UPDATE … SET
-- period) — and both must sit inside one transaction.
--
-- The row is re-read by id rather than trusted from NEW: a deferred trigger
-- fires at COMMIT, but NEW still holds the row image from the statement that
-- queued it — which for a reservation is the INSERT, before the period was
-- set. It is also why converting RESERVED → OPEN is safe: the re-read sees
-- the post-conversion status and the period that went with it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rental_requires_period() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
BEGIN
  SELECT "status", period INTO current_row FROM "Rental" WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL; -- deleted later in the same transaction; nothing to enforce
  END IF;

  IF current_row.status IN ('OPEN', 'OVERDUE', 'RESERVED') AND current_row.period IS NULL THEN
    RAISE EXCEPTION
      'Rental % is % but carries no reservation period', NEW.id, current_row.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
