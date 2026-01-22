-- Migration 005: Enable RLS and create policies
-- This is the CORE of our multi-tenant isolation strategy
-- RLS policies automatically enforce tenant boundaries at the database level

-- ============================================================================
-- ENABLE RLS ON ALL TENANT-SCOPED TABLES
-- ============================================================================

-- Enable RLS on users table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- Enable RLS on projects table
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- Enable RLS on tasks table
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

-- FORCE ROW LEVEL SECURITY explanation:
-- Without FORCE: table owners can bypass RLS
-- With FORCE: even table owners respect RLS (unless they have BYPASSRLS attribute)
-- This ensures consistent isolation enforcement

-- ============================================================================
-- USERS TABLE POLICIES (Complete set)
-- ============================================================================

-- SELECT policy: users can only see rows in their tenant
CREATE POLICY users_select ON users
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- INSERT policy: users can only insert rows for their tenant
CREATE POLICY users_insert ON users
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- UPDATE policy: users can only update rows in their tenant
-- USING: restricts which existing rows can be updated
-- WITH CHECK: validates the new values still belong to the tenant
CREATE POLICY users_update ON users
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- DELETE policy: users can only delete rows in their tenant
CREATE POLICY users_delete ON users
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- ============================================================================
-- TASKS TABLE POLICIES (Complete set)
-- ============================================================================

-- SELECT policy: tasks can only see rows in their tenant
CREATE POLICY tasks_select ON tasks
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- INSERT policy: tasks can only insert rows for their tenant
CREATE POLICY tasks_insert ON tasks
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- UPDATE policy: tasks can only update rows in their tenant
CREATE POLICY tasks_update ON tasks
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- DELETE policy: tasks can only delete rows in their tenant
CREATE POLICY tasks_delete ON tasks
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- ============================================================================
-- PROJECTS TABLE POLICIES (Partial set - SELECT comes in migration 006)
-- ============================================================================

-- INSERT policy: projects can only insert rows for their tenant
CREATE POLICY projects_insert ON projects
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- UPDATE policy: projects can only update rows in their tenant
CREATE POLICY projects_update ON projects
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- DELETE policy: projects can only delete rows in their tenant
CREATE POLICY projects_delete ON projects
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- NOTE: projects_select policy is created separately in migration 006
-- This allows us to add privileged access clause to SELECT without dropping other policies

-- ============================================================================
-- POLICY DESIGN NOTES
-- ============================================================================

-- current_setting('app.current_tenant_id', true)::UUID
--   - Second parameter 'true' means "missing-safe"
--   - If tenant context not set, returns NULL instead of erroring
--   - NULL = anything → FALSE in SQL (fail-closed behavior)
--   - Returns zero rows instead of causing errors

-- USING vs WITH CHECK:
--   - USING: Applies to SELECT, UPDATE (existing rows), DELETE
--   - WITH CHECK: Applies to INSERT, UPDATE (new values)
--   - UPDATE needs both: USING for "which rows can I update" + WITH CHECK for "what values are valid"

-- Why explicit policies for each operation:
--   - PostgreSQL policies are permissive by default (OR'd together)
--   - Separate policies per operation prevent accidental policy widening
--   - Makes intent crystal clear in policy listing

-- Type safety note:
--   - ::UUID cast will error if non-UUID string is set
--   - This is acceptable fail-closed behavior (query errors vs returning wrong data)
--   - Middleware validates UUID format before setting GUC to prevent noisy 500 errors
