-- ============================================================================
-- OPTIONAL: Postgres Row-Level Security as defence in depth  (BUILD_SPEC §8)
--
-- This is NOT part of the migration chain, and applying it will break the app
-- until the two prerequisites below are in place. Read before running.
--
-- Today, tenant isolation is enforced in the application: `dbForOrg()` folds
-- `orgId` into every query and stamps it on every write, and
-- `scripts/verify-invariants.ts` asserts that a scoped client can neither read
-- another tenant's rows nor write into one. RLS adds a second, independent
-- layer so that a raw query or a future bug still cannot cross the boundary.
--
-- Prerequisites:
--
--   1. A NON-OWNER database role for the app. RLS is bypassed by the table
--      owner and by superusers, so running as the owner makes these policies
--      decorative:
--
--        CREATE ROLE assethub_app LOGIN PASSWORD '...';
--        GRANT USAGE ON SCHEMA public TO assethub_app;
--        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--          TO assethub_app;
--        ALTER DEFAULT PRIVILEGES IN SCHEMA public
--          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assethub_app;
--
--      Point DATABASE_URL at assethub_app and keep the owner credentials for
--      migrations only (DIRECT_URL).
--
--   2. Every request must set the current org before it queries. With a
--      connection pool that means per-transaction:
--
--        await prisma.$transaction(async (tx) => {
--          await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`
--          ...
--        })
--
--      `true` scopes the setting to the transaction, so a pooled connection
--      never leaks one tenant's context into the next request. Wiring that in
--      means routing all reads through transactions — a deliberate trade, and
--      the reason this is opt-in rather than default.
--
-- Recommended sequencing: turn this on when the second tenant is onboarded,
-- not before.
-- ============================================================================

CREATE OR REPLACE FUNCTION current_org_id() RETURNS text AS $$
  SELECT nullif(current_setting('app.current_org', true), '');
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'Membership', 'Category', 'Location', 'CustomFieldDefinition', 'Truck',
    'Asset', 'CustodyEvent', 'Attachment', 'Customer', 'Job', 'Rental',
    'Consumable', 'ConsumableTxn', 'MaintenanceSchedule', 'MaintenanceRecord',
    'MaintenanceTicket', 'InspectionTemplate', 'InspectionTemplateItem',
    'Inspection', 'InspectionResponse', 'Notification', 'AuditLog',
    'NetsuiteConfig', 'NetsuiteRef'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("orgId" = current_org_id())
         WITH CHECK ("orgId" = current_org_id())', t);
  END LOOP;
END $$;

-- To roll back:
--   DO $$ DECLARE t text; BEGIN
--     FOREACH t IN ARRAY ARRAY['Membership','Category', ...] LOOP
--       EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--     END LOOP;
--   END $$;
