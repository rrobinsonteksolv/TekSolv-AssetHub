-- ============================================================================
-- Phase 5: maintenance alerting needs an idempotency key. (BUILD_SPEC §6.4)
--
-- The digest cron runs on a schedule, and "this schedule is overdue" stays
-- true until somebody services the unit. Without a marker, every run would
-- re-alert every overdue schedule — a supervisor would get the same twelve
-- notifications every morning and stop reading them, which is the failure mode
-- an alert feed exists to avoid.
--
-- `alertedAt` is the same shape as `Rental.noShowAt` from Phase 4b and works
-- the same way: the sweep claims a row with `alertedAt IS NULL`, and logging
-- service (or adjusting the reading) clears it so the *next* time the schedule
-- comes due it alerts again.
-- ============================================================================

ALTER TABLE "MaintenanceSchedule" ADD COLUMN IF NOT EXISTS "alertedAt" TIMESTAMP(3);

-- The due queue and the sweep both read "active schedules, soonest first".
-- The existing [orgId, nextDue] index does not cover the active filter, so a
-- fleet with a long tail of retired schedules would scan them every run.
CREATE INDEX IF NOT EXISTS "MaintenanceSchedule_orgId_active_nextDue_idx"
  ON "MaintenanceSchedule" ("orgId", "active", "nextDue");
