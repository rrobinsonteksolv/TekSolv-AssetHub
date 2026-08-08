-- ============================================================================
-- Reservation integrity: no asset can be double-booked.  (BUILD_SPEC §3.2)
--
-- Prisma models the `period` column as Unsupported("tstzrange"). This
-- migration adds btree_gist and an EXCLUDE constraint so Postgres itself
-- refuses any two OPEN/OVERDUE rentals of the same asset whose windows
-- overlap. App-level guards are a fast-fail convenience; THIS is the
-- guarantee.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Only OPEN and OVERDUE rentals reserve the asset. Returned/cancelled rows are
-- excluded via the WHERE clause so historical rentals never block new checkouts.
ALTER TABLE "Rental"
  ADD CONSTRAINT rental_no_overlap
  EXCLUDE USING gist (
    "assetId" WITH =,
    period    WITH &&
  )
  WHERE (status IN ('OPEN', 'OVERDUE'));

-- Helpful index for the "currently reserved" queries used by the dashboard.
CREATE INDEX IF NOT EXISTS rental_period_gist
  ON "Rental" USING gist (period)
  WHERE status IN ('OPEN', 'OVERDUE');

-- ---------------------------------------------------------------------------
-- Close the loophole in the constraint above: a NULL period overlaps nothing,
-- so an open rental that never got its window set would silently reserve
-- nothing at all. Prisma cannot write a tstzrange, so checkout necessarily
-- happens in two statements (INSERT, then UPDATE ... SET period). A DEFERRED
-- constraint trigger lets those two statements coexist inside one transaction
-- while still refusing to commit a reservation-less open rental.
--
-- Consequence for callers: creating an OPEN/OVERDUE rental and setting its
-- period MUST happen in the same transaction. That is exactly what the
-- checkout server action does.
-- ---------------------------------------------------------------------------

-- The row is re-read by id rather than trusted from NEW: a deferred trigger
-- fires at COMMIT but NEW still holds the row image from the statement that
-- queued it, which for checkout is the INSERT — before the period was set.
CREATE OR REPLACE FUNCTION rental_requires_period() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
BEGIN
  SELECT "status", period INTO current_row FROM "Rental" WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL; -- deleted later in the same transaction; nothing to enforce
  END IF;

  IF current_row.status IN ('OPEN', 'OVERDUE') AND current_row.period IS NULL THEN
    RAISE EXCEPTION
      'Rental % is % but carries no reservation period', NEW.id, current_row.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER rental_period_required
  AFTER INSERT OR UPDATE ON "Rental"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rental_requires_period();
