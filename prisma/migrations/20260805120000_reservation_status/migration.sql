-- ============================================================================
-- Phase 4b, part 1 of 2: the enum values, and nothing else. (BUILD_SPEC §6.6)
--
-- This file exists on its own because Postgres refuses to let a transaction
-- both add an enum value and use it:
--
--   ERROR:  unsafe use of new value "RESERVED" of enum type "RentalStatus"
--   HINT:   New enum values must be committed before they can be used.
--
-- Prisma wraps each migration in a transaction, so the ALTER TYPE must commit
-- in its own file before 20260805120100_reservations can name 'RESERVED' in
-- the exclusion constraint's WHERE clause. Adding a value is transactional in
-- Postgres 12+; only referencing it is not. Nothing here touches a table, so
-- this migration is instant and safe to run on a live database.
--
-- Do not add anything else to this file. Anything that *uses* either value
-- belongs in the next migration.
-- ============================================================================

ALTER TYPE "RentalStatus" ADD VALUE IF NOT EXISTS 'RESERVED';

-- The no-show alert (§6.6) needs its own notification type for the same
-- reason, and for the same one-migration-earlier reason it goes here.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESERVATION_NO_SHOW';
