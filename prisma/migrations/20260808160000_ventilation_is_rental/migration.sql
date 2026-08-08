-- Ventilation is rental gear, not rescue gear.
--
-- Canister fans, blowers and air movers rent out exactly like meters and SCBAs
-- do. They were landing as RESCUE because they live on a truck — but that is
-- *custody*, not classification, and the two are independent: a fan classified
-- RENTAL still appears in Truck 167's loadout.
--
-- The cost of the mistake was quiet. A RESCUE unit is excluded from the rental
-- fleet and from utilization, so a fan that rents out several times a year was
-- contributing nothing to either, and the fleet's utilization was computed over
-- a denominator missing gear that genuinely earns.
--
-- Custody is deliberately untouched: this flips a classification and nothing
-- else, so anything staged on a truck stays staged on it.
UPDATE "Asset" AS a
SET "assetType" = 'RENTAL'
FROM "Category" AS c
LEFT JOIN "Category" AS parent ON parent."id" = c."parentId"
WHERE a."categoryId" = c."id"
  AND a."assetType" = 'RESCUE'
  AND (
    c."name" ILIKE '%ventilation%'
    OR c."name" ILIKE '%blower%'
    OR c."name" ILIKE '%air mover%'
    OR parent."name" ILIKE '%ventilation%'
  );
