-- ============================================================================
-- Inspection template items get a named section. (BUILD_SPEC §6.5)
--
-- The seeded templates are flat lists, which is right for a six-line bump
-- test. A real printed form is not: TekSolv's Full Body Harness form (FP-01)
-- groups its items under HARDWARE / WEBBING / STITCHING / LABELS & TAGS, and
-- an inspector working down a harness checks all the hardware, then all the
-- webbing. Flattening that would change the order the job is actually done in,
-- and would make the generated form stop matching the paper one it replaces.
--
-- Nullable, so every existing template keeps rendering exactly as it does now:
-- a null section simply means "no heading", and the runner falls back to one
-- ungrouped list.
-- ============================================================================

ALTER TABLE "InspectionTemplateItem" ADD COLUMN IF NOT EXISTS "section" TEXT;

-- Items are ordered within their section, so the queue reads section-then-order.
CREATE INDEX IF NOT EXISTS "InspectionTemplateItem_templateId_section_order_idx"
  ON "InspectionTemplateItem" ("templateId", "section", "order");
