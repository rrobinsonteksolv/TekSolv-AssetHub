-- A bag's name is unique within the holder it sits at, not across the whole org.
--
-- Org-wide uniqueness quietly merged two different bags: an office sheet naming
-- a "Harnesses" bag bound its items to the rescue yard's bag of the same name,
-- and that bag then read incomplete forever because half its contents were in
-- another building. Nothing errored, which is the worst part.
--
-- Two partial indexes rather than one composite, because exactly one of the two
-- holder columns is ever set (the container_has_one_holder CHECK says so) and
-- NULLs do not collide in a plain unique index — so a single
-- (orgId, truckId, locationId, name) index would enforce nothing at all.

DROP INDEX IF EXISTS "Container_orgId_name_key";

CREATE UNIQUE INDEX "container_name_per_truck"
  ON "Container" ("orgId", "truckId", "name")
  WHERE "truckId" IS NOT NULL;

CREATE UNIQUE INDEX "container_name_per_location"
  ON "Container" ("orgId", "locationId", "name")
  WHERE "locationId" IS NOT NULL;
