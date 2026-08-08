-- Tighten the column the previous migration filled.
--
-- Split out because `Rental` carries a DEFERRED constraint trigger: the backfill
-- UPDATE queues trigger events, and Postgres refuses ALTER TABLE on a table with
-- pending ones inside the same transaction. Each migration file is its own
-- transaction, so the ALTER lands cleanly here.

ALTER TABLE "Rental" ALTER COLUMN "orderId" SET NOT NULL;

ALTER TABLE "Rental" ADD CONSTRAINT "Rental_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Rental_orderId_idx" ON "Rental" ("orderId");
