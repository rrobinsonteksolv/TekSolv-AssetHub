-- ============================================================================
-- Inspection frequency and next-due date.
--
-- Form FP-01's Inspection Record asks two questions the runner never captured:
-- how often this unit is inspected, and when it is next due. Until now the
-- printed form guessed both by looking for *any* active calendar schedule on
-- the unit — which on a harness that also has a monthly calibration printed the
-- calibration's interval. The inspector's answer belongs on the inspection.
--
--   frequencyDays  the interval the competent person set, in days. Stored as
--                  days rather than a MONTHLY/ANNUAL enum so "every 45 days"
--                  needs no schema change and so it drops straight into
--                  MaintenanceSchedule.intervalDays. The word on the form
--                  ("Annual") is derived from the number, not stored beside it.
--   nextDueAt      when it is next due. Auto-computed from the inspection date
--                  plus the frequency, but stored because the inspector may
--                  override it — a harness going into storage, a job that ends
--                  before the interval does — and the form must print what was
--                  actually decided.
--
-- The schedule link is what keeps this from becoming a second reminder system.
-- Completing an inspection advances a CALENDAR MaintenanceSchedule of type
-- INSPECTION on the unit, so it appears in the same maintenance queue and fires
-- the same digest alert as a calibration. `inspectionTemplateId` is how the
-- next inspection finds the schedule the last one armed: matching on the label
-- would break the moment somebody renamed the template, and matching on type
-- alone would collide between two inspection programs on one unit.
--
-- Nullable throughout: every inspection filed before today has no frequency,
-- and the FP-01 falls back to the old schedule-derived reading for those.
-- ============================================================================

ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "frequencyDays" INTEGER;
ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "nextDueAt" TIMESTAMP(3);

ALTER TABLE "MaintenanceSchedule" ADD COLUMN IF NOT EXISTS "inspectionTemplateId" TEXT;

-- ON DELETE SET NULL, not CASCADE: a template is retired rather than deleted
-- precisely because inspections point at it, but if one ever is removed the
-- schedule must survive — the unit still needs inspecting.
DO $$
BEGIN
  ALTER TABLE "MaintenanceSchedule"
    ADD CONSTRAINT "MaintenanceSchedule_inspectionTemplateId_fkey"
    FOREIGN KEY ("inspectionTemplateId") REFERENCES "InspectionTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "MaintenanceSchedule_orgId_inspectionTemplateId_idx"
  ON "MaintenanceSchedule"("orgId", "inspectionTemplateId");
