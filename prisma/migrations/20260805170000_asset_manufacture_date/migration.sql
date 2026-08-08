-- ============================================================================
-- Assets get a manufacture date, distinct from the purchase date.
--
-- For safety gear these are genuinely different dates and only one of them
-- matters for service life: a harness manufactured in 2019 and bought in 2024
-- is a five-year-old harness. Manufacturers set retirement from date of
-- manufacture (ANSI/ASSP Z359 and the maker's own instructions), and Form
-- FP-01 asks for it explicitly — until now that field on the printed form had
-- no source in the database at all.
--
-- **Not a NetSuite field.** FAM does not carry a manufacture date, so this is
-- entered in AssetHub and stays there. The sync writes an explicit allow-list
-- of NetSuite-owned columns (`owned` in src/lib/netsuite/sync.ts); anything
-- absent from that object is untouched by construction, which is why no code
-- change is needed to protect this — and why `verify-netsuite-ownership`
-- asserts it rather than trusting it.
-- ============================================================================

ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "manufactureDate" TIMESTAMP(3);
