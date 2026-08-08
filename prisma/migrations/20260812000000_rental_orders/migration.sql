-- A rental is an ORDER holding many assets.
--
-- Customers take several things at once. Each unit used to be its own unrelated
-- rental, so four monitors on one truck meant four records with the same
-- customer typed four times, no way to bring them back together, and no figure
-- for what one job is holding.
--
-- **Additive.** The order groups rentals; it does not replace them. Custody and
-- status stay per asset, and `rental_no_overlap` still refuses to double-book a
-- unit — that GIST constraint is defined on the line row and reads the line's
-- own assetId and period, which is why a line keeps its own dates rather than
-- reading its order's.
--
-- Every existing rental becomes a one-line order, so there is one shape from
-- here on and no code has to ask which it is looking at.

CREATE TABLE "RentalOrder" (
  "id"                 TEXT NOT NULL,
  "orgId"              TEXT NOT NULL,
  "kind"               "RentalKind" NOT NULL DEFAULT 'CUSTOMER',
  "customerId"         TEXT,
  "jobId"              TEXT,
  "orderNumber"        TEXT,
  "contactName"        TEXT,
  "destination"        TEXT,
  "checkoutMethod"     "CheckoutMethod" NOT NULL DEFAULT 'TECH',
  "recordedById"       TEXT NOT NULL,
  "checkedOutById"     TEXT,
  "checkoutDate"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expectedReturnDate" TIMESTAMP(3) NOT NULL,
  "closedAt"           TIMESTAMP(3),
  "notes"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RentalOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RentalOrder_orgId_closedAt_idx"   ON "RentalOrder" ("orgId", "closedAt");
CREATE INDEX "RentalOrder_orgId_customerId_idx" ON "RentalOrder" ("orgId", "customerId");

ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_checkedOutById_fkey"
  FOREIGN KEY ("checkedOutById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One order per existing rental, carrying that rental's own facts.
INSERT INTO "RentalOrder" (
  "id", "orgId", "kind", "customerId", "jobId", "orderNumber", "contactName",
  "destination", "checkoutMethod", "recordedById", "checkedOutById",
  "checkoutDate", "expectedReturnDate", "closedAt", "createdAt", "updatedAt"
)
SELECT
  'ro_' || r."id",
  r."orgId", r."kind", r."customerId", r."jobId", r."orderNumber", r."contactName",
  r."destination", r."checkoutMethod", r."recordedById", r."checkedOutById",
  r."checkoutDate", r."expectedReturnDate",
  -- A rental already back is an order already closed.
  r."actualReturnDate",
  r."createdAt", CURRENT_TIMESTAMP
FROM "Rental" r;

ALTER TABLE "Rental" ADD COLUMN "orderId" TEXT;
UPDATE "Rental" SET "orderId" = 'ro_' || "id";

-- The column is left nullable here on purpose. `Rental` carries a DEFERRED
-- constraint trigger, so the UPDATE above queues trigger events and Postgres
-- then refuses an ALTER TABLE in the same transaction ("pending trigger
-- events"). Tightening it is the next migration, which gets its own.
