-- ============================================================================
-- Custody changes get their own notification type. (BUILD_SPEC §6.2)
--
-- Assigning a unit to a person or staging it on a truck is exactly as
-- consequential as a field grab — it moves equipment and changes what a rescue
-- truck is carrying — but until now it told nobody. It could have reused
-- EQUIPMENT_TAKEN, whose comment says "a worker grabbed gear / supplies", but
-- that would make the alert feed's icon and any future filter lie about what
-- happened. A custody change is not a grab.
--
-- Adding an enum value is safe on its own; nothing in this migration *uses* it,
-- which is what Postgres refuses inside a single transaction.
-- ============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTODY_CHANGED';
