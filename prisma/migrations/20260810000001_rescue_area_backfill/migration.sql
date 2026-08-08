-- Move the two rescue areas onto the new type.
--
-- Split from the ALTER TYPE in the previous migration because Postgres will not
-- let a new enum value be used in the same transaction that adds it.
--
-- Matched by name and by what they actually hold: a location carrying gear and
-- kits is somewhere gear lives, not a site on the org chart. The real offices
-- (Collinsville, Newark, Oakdale) hold nothing and keep their type — Newark is
-- printed on CAL-01 certificates as the place a calibration was performed, so
-- the OFFICE type stays rather than being retired.

UPDATE "Location"
SET "type" = 'RESCUE_AREA'
WHERE "type" = 'OFFICE'
  AND "name" IN ('Rescue Prop', 'Ops Manager Office');
