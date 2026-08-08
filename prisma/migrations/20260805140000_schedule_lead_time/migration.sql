-- ============================================================================
-- Per-schedule lead time, and staged alerting. (BUILD_SPEC §6.4)
--
-- Two columns, for two related problems:
--
-- 1. `leadDays` — how far ahead "coming up" starts. This was a single global
--    constant (30 days for every calendar schedule), which is wrong in both
--    directions: a monthly calibration warned from the moment it was last
--    performed, and a five-year hydro gave a month's notice on a job that
--    needs booking. It belongs to the schedule, not to the codebase.
--
-- 2. `alertedState` — which stage the digest last alerted on.
--
--    `alertedAt` alone cannot express this. It is a single flag: stamp it for
--    the "coming up" heads-up and the schedule is now marked as alerted, so
--    when it actually falls due — the alert that matters — the sweep skips it.
--    Clearing it instead would re-alert on every run. Recording the *stage*
--    lets each escalation fire exactly once: soon, then due/overdue.
--
-- Default 7 rather than the old 30: a week is enough notice to book a service
-- slot and short enough that the warning still means something. Existing rows
-- adopt it, which deliberately narrows their warning window.
-- ============================================================================

ALTER TABLE "MaintenanceSchedule"
  ADD COLUMN IF NOT EXISTS "leadDays" INTEGER NOT NULL DEFAULT 7;

-- Nullable: null means "nothing alerted since the last service".
-- Values: 'soon' | 'due' | 'overdue', matching ScheduleState in
-- src/lib/maintenance.ts.
ALTER TABLE "MaintenanceSchedule"
  ADD COLUMN IF NOT EXISTS "alertedState" TEXT;

-- Rows already alerted under the old rule were only ever stamped once they
-- were due or overdue, so backfill them at the stage that matches. Without
-- this they would look like "alerted at no particular stage" and immediately
-- re-alert on the next sweep.
UPDATE "MaintenanceSchedule"
   SET "alertedState" = 'due'
 WHERE "alertedAt" IS NOT NULL
   AND "alertedState" IS NULL;
