-- What a lost unit is worth to invoice.
--
-- Split from the enum change because Postgres will not let a new enum value be
-- used in the same transaction that adds it.
--
-- The flag and the amount are separate columns on purpose: a unit can be
-- written off without being charged on — goodwill, a disputed loss, an internal
-- grab — and an amount with no flag would read as a bill nobody agreed to send.

ALTER TABLE "Rental" ADD COLUMN "lostBillable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Rental" ADD COLUMN "lostChargeAmount" DECIMAL(12,2);
