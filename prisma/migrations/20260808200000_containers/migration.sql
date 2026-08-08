-- Containers: a bag, box or kit that gear lives in.
--
-- A grouping *within* a holder, not a replacement for one. The bag sits on
-- Truck 167 and the gear in it is staged on Truck 167 too — container
-- membership and custody are separate columns answering separate questions:
-- which kit does this belong to, and where is it right now.
--
-- That separation is what makes "incomplete" answerable with no manifest table.
-- Membership is the expectation; custody is the presence.

CREATE TABLE "Container" (
  "id"         TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "notes"      TEXT,
  "truckId"    TEXT,
  "locationId" TEXT,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Container_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Container_orgId_name_key" ON "Container"("orgId", "name");
CREATE INDEX "Container_orgId_truckId_idx" ON "Container"("orgId", "truckId");
CREATE INDEX "Container_orgId_locationId_idx" ON "Container"("orgId", "locationId");

ALTER TABLE "Container"
  ADD CONSTRAINT "Container_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Container_truckId_fkey" FOREIGN KEY ("truckId")
    REFERENCES "Truck"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Container_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A bag is on a truck or in a room, never both. A bag that is nowhere is a bag
-- nobody can be sent to fetch, so exactly one holder is required.
ALTER TABLE "Container" ADD CONSTRAINT "container_has_one_holder" CHECK (
  ("truckId" IS NOT NULL AND "locationId" IS NULL)
  OR ("truckId" IS NULL AND "locationId" IS NOT NULL)
);

ALTER TABLE "Asset" ADD COLUMN "containerId" TEXT;

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_containerId_fkey" FOREIGN KEY ("containerId")
    REFERENCES "Container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Asset_orgId_containerId_idx" ON "Asset"("orgId", "containerId");
