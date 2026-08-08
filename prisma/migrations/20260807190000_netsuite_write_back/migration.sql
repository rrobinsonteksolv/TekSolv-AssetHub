-- NetSuite write-back: one narrow, opt-in path out of a read-only bridge.

CREATE TYPE "NetsuiteWriteMode" AS ENUM ('DISABLED', 'DRY_RUN', 'SEND');
CREATE TYPE "NetsuiteWriteStatus" AS ENUM ('PLANNED', 'SENT', 'FAILED', 'REFUSED', 'DUPLICATE');

ALTER TABLE "NetsuiteConfig"
  ADD COLUMN "writeMode" "NetsuiteWriteMode" NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN "allowProductionWrites" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assetStatusField" TEXT,
  ADD COLUMN "assetStatusOnRent" TEXT,
  ADD COLUMN "assetStatusAvailable" TEXT;

CREATE TABLE "NetsuiteWrite" (
  "id"             TEXT NOT NULL,
  "orgId"          TEXT NOT NULL,
  "trigger"        TEXT NOT NULL,
  "entityType"     TEXT NOT NULL,
  "localId"        TEXT NOT NULL,
  "netsuiteId"     TEXT,
  "netsuiteType"   TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "mode"           "NetsuiteWriteMode" NOT NULL,
  "status"         "NetsuiteWriteStatus" NOT NULL,
  "request"        JSONB NOT NULL,
  "response"       JSONB,
  "previous"       JSONB,
  "detail"         TEXT,
  "attemptedById"  TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NetsuiteWrite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NetsuiteWrite_orgId_createdAt_idx" ON "NetsuiteWrite"("orgId", "createdAt");
CREATE INDEX "NetsuiteWrite_orgId_localId_idx" ON "NetsuiteWrite"("orgId", "localId");
CREATE INDEX "NetsuiteWrite_orgId_idempotencyKey_idx" ON "NetsuiteWrite"("orgId", "idempotencyKey");

ALTER TABLE "NetsuiteWrite"
  ADD CONSTRAINT "NetsuiteWrite_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "NetsuiteWrite_attemptedById_fkey" FOREIGN KEY ("attemptedById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Idempotency, enforced by the database rather than by remembering to check.
--
-- Partial on purpose. At most one *successful* write per logical transition, so
-- a double-fire or a retry after success cannot produce a second update — while
-- a FAILED attempt stays retryable and a DRY_RUN rehearsal never consumes the
-- slot the real send will need. A plain unique index would have made the
-- rehearsal block the performance.
CREATE UNIQUE INDEX "NetsuiteWrite_sent_once"
  ON "NetsuiteWrite"("orgId", "idempotencyKey")
  WHERE "status" = 'SENT';
