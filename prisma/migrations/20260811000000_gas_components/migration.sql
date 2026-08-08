-- Calibration gas is usually a blend, not one gas.
--
-- `Consumable.gasType` + `Consumable.concentration` could describe a single-gas
-- cylinder and nothing else. A 4-gas is H2S, CO, O2 and LEL/CH4 together, each
-- with its own number and its own unit — PPM for the toxics, % by volume for
-- oxygen, % LEL for the combustible. The only way to record that in one text
-- box was to type all four into it, which is a list pretending to be a value,
-- and it printed onto Form CAL-01 as whatever somebody happened to type.
--
-- The old pair is backfilled into a single component and then dropped: two
-- places to look for the same fact is how they drift.

CREATE TYPE "GasUnit" AS ENUM ('PPM', 'PERCENT_VOL', 'PERCENT_LEL');

CREATE TABLE "GasComponent" (
  "id"           TEXT NOT NULL,
  "orgId"        TEXT NOT NULL,
  "consumableId" TEXT NOT NULL,
  "gas"          TEXT NOT NULL,
  "amount"       TEXT NOT NULL,
  "unit"         "GasUnit" NOT NULL,
  "position"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GasComponent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GasComponent_orgId_consumableId_idx" ON "GasComponent" ("orgId", "consumableId");

ALTER TABLE "GasComponent"
  ADD CONSTRAINT "GasComponent_orgId_fkey" FOREIGN KEY ("orgId")
  REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GasComponent"
  ADD CONSTRAINT "GasComponent_consumableId_fkey" FOREIGN KEY ("consumableId")
  REFERENCES "Consumable" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every item that named a gas becomes a one-component blend.
--
-- The unit is read off the end of the old free-text concentration and the
-- number off the front. Anything that parses as neither keeps its whole string
-- as the amount with PPM assumed — visibly odd on the form, which is the right
-- outcome for a value nobody can interpret, and better than dropping it.
INSERT INTO "GasComponent" ("id", "orgId", "consumableId", "gas", "amount", "unit", "position", "updatedAt")
SELECT
  'gc_' || "id",
  "orgId",
  "id",
  COALESCE(NULLIF(TRIM("gasType"), ''), 'Gas'),
  COALESCE(
    NULLIF(TRIM(SUBSTRING(COALESCE("concentration", '') FROM '^[0-9]+\.?[0-9]*')), ''),
    TRIM(COALESCE("concentration", '')),
    ''
  ),
  CASE
    WHEN "concentration" ILIKE '%lel%' THEN 'PERCENT_LEL'::"GasUnit"
    WHEN "concentration" LIKE '%\%%' THEN 'PERCENT_VOL'::"GasUnit"
    ELSE 'PPM'::"GasUnit"
  END,
  0,
  CURRENT_TIMESTAMP
FROM "Consumable"
WHERE "gasType" IS NOT NULL OR "concentration" IS NOT NULL;

ALTER TABLE "Consumable" DROP COLUMN "gasType";
ALTER TABLE "Consumable" DROP COLUMN "concentration";
