-- ============================================================================
-- Public, read-only calibration reports.
--
-- The calibration sticker's QR used to point at `/api/scan/<assetTag>`, which
-- resolves to the unit's page — behind the session guard. That is the wrong
-- destination for this label twice over: it answers "which unit is this"
-- rather than "what does its calibration say", and the person scanning a
-- sticker on a monitor at a customer site is usually a safety officer with no
-- login, who lands on a sign-in page holding a gas detector.
--
-- So a calibration record gains an unguessable token, and `/c/<token>` serves
-- a read-only copy of that one report to anybody holding the link. The token
-- is the authorization; there is no session and nothing to edit.
--
-- **Stored, not derived.** An HMAC over the record id would need no column,
-- but the URL is printed on the label as text as well as encoded in the code,
-- and a signature over a 25-character cuid is far too long to read off a
-- sticker or type. A stored token is short, and it can be rotated for one
-- certificate without invalidating every other.
--
-- Existing calibrations are backfilled so stickers can be reprinted for work
-- already done. `gen_random_uuid()` is available here — the reservation
-- integrity migration already relies on pgcrypto being present — and its hex
-- is more than unguessable enough at 22 characters.
-- ============================================================================

ALTER TABLE "MaintenanceRecord" ADD COLUMN IF NOT EXISTS "publicToken" TEXT;

UPDATE "MaintenanceRecord"
SET "publicToken" = replace(gen_random_uuid()::text, '-', '')
WHERE "type" = 'CALIBRATION'
  AND "calibration" IS NOT NULL
  AND "publicToken" IS NULL;

-- Globally unique, not per-org: the public route has no session and therefore
-- no tenant to scope the lookup by, so the token has to identify the record on
-- its own. A per-org index would let two orgs collide and make the route
-- ambiguous at exactly the moment it cannot ask who is calling.
CREATE UNIQUE INDEX IF NOT EXISTS "MaintenanceRecord_publicToken_key"
  ON "MaintenanceRecord"("publicToken");
