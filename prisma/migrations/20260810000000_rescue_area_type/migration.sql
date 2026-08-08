-- Rescue areas are not offices.
--
-- "Rescue Prop" and "Ops Manager Office" were both typed OFFICE, which is the
-- label that existed rather than the one that fits: they hold rope, harnesses
-- and SCBA in kits, and they sat in the settings list next to Newark and
-- Oakdale, which are buildings with a street address and no gear in them.
--
-- Reclassification only. Nothing moves, nothing is created, and no asset,
-- custody row or container is touched — the areas keep their ids, so every
-- item held at one stays held at it.

ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'RESCUE_AREA';
