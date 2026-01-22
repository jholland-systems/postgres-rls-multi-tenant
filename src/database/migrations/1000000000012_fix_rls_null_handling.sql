-- Migration 012: Fix RLS policies to handle NULL and empty string tenant context
--
-- Issue: When tenant context is RESET or missing, current_setting() may return
-- empty string '' instead of NULL, causing UUID cast errors.
--
-- Solution: Use NULLIF to convert empty strings to NULL before casting to UUID.
-- This ensures fail-closed behavior: NULL comparisons return FALSE, yielding zero rows.

-- ============================================================================
-- DROP AND RECREATE USERS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS users_select ON users;
DROP POLICY IF EXISTS users_insert ON users;
DROP POLICY IF EXISTS users_update ON users;
DROP POLICY IF EXISTS users_delete ON users;

CREATE POLICY users_select ON users
    FOR SELECT
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY users_insert ON users
    FOR INSERT
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY users_update ON users
    FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY users_delete ON users
    FOR DELETE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

-- ============================================================================
-- DROP AND RECREATE PROJECTS POLICIES (except SELECT - handled separately)
-- ============================================================================

DROP POLICY IF EXISTS projects_insert ON projects;
DROP POLICY IF EXISTS projects_update ON projects;
DROP POLICY IF EXISTS projects_delete ON projects;

CREATE POLICY projects_insert ON projects
    FOR INSERT
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY projects_update ON projects
    FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY projects_delete ON projects
    FOR DELETE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

-- ============================================================================
-- UPDATE PROJECTS SELECT POLICY (preserve privileged access logic)
-- ============================================================================

DROP POLICY IF EXISTS projects_select ON projects;

CREATE POLICY projects_select ON projects
    FOR SELECT
    USING (
        -- Normal tenant isolation (primary use case) - with NULLIF fix
        tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID
        OR
        -- Privileged admin access (explicit opt-in, dangerous)
        COALESCE(current_setting('app.is_superadmin', true), 'false') = 'true'
    );

COMMENT ON POLICY projects_select ON projects IS
    'Tenant isolation with privileged access: SELECT returns rows matching tenant context OR if app.is_superadmin=true (for platform analytics/billing). Privileged access MUST be audited.';

-- ============================================================================
-- DROP AND RECREATE TASKS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS tasks_select ON tasks;
DROP POLICY IF EXISTS tasks_insert ON tasks;
DROP POLICY IF EXISTS tasks_update ON tasks;
DROP POLICY IF EXISTS tasks_delete ON tasks;

CREATE POLICY tasks_select ON tasks
    FOR SELECT
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY tasks_insert ON tasks
    FOR INSERT
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY tasks_update ON tasks
    FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

CREATE POLICY tasks_delete ON tasks
    FOR DELETE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);

-- ============================================================================
-- EXPLANATION
-- ============================================================================
--
-- NULLIF(current_setting('app.current_tenant_id', true), '')
--   - If current_setting returns '', converts it to NULL
--   - If current_setting returns NULL, leaves it as NULL
--   - If current_setting returns a UUID string, leaves it as-is
--
-- Then ::UUID cast:
--   - NULL::UUID → NULL (no error)
--   - 'valid-uuid'::UUID → valid UUID value
--   - 'invalid'::UUID → error (acceptable - middleware should validate)
--
-- Then comparison (tenant_id = NULL):
--   - In SQL, anything = NULL evaluates to NULL (not TRUE, not FALSE)
--   - In WHERE/USING clauses, NULL is treated as FALSE
--   - Result: fail-closed behavior - no context = no rows returned
