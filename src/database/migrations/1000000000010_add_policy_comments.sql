-- Migration 005b: Add COMMENT ON POLICY for professional documentation
-- Policy comments explain the purpose and behavior of each RLS policy
-- Visible via \d+ table_name in psql and pg_policies system view

-- ============================================================================
-- USERS TABLE POLICY COMMENTS
-- ============================================================================

COMMENT ON POLICY users_select ON users IS
    'Tenant isolation: users can only SELECT rows matching their tenant context (app.current_tenant_id)';

COMMENT ON POLICY users_insert ON users IS
    'Tenant isolation: users can only INSERT rows for their tenant context (app.current_tenant_id)';

COMMENT ON POLICY users_update ON users IS
    'Tenant isolation: users can only UPDATE rows in their tenant context. Both USING and WITH CHECK ensure tenant boundary is maintained.';

COMMENT ON POLICY users_delete ON users IS
    'Tenant isolation: users can only DELETE rows in their tenant context (app.current_tenant_id)';

-- ============================================================================
-- TASKS TABLE POLICY COMMENTS
-- ============================================================================

COMMENT ON POLICY tasks_select ON tasks IS
    'Tenant isolation: tasks can only SELECT rows matching their tenant context (app.current_tenant_id)';

COMMENT ON POLICY tasks_insert ON tasks IS
    'Tenant isolation: tasks can only INSERT rows for their tenant context (app.current_tenant_id)';

COMMENT ON POLICY tasks_update ON tasks IS
    'Tenant isolation: tasks can only UPDATE rows in their tenant context. Both USING and WITH CHECK ensure tenant boundary is maintained.';

COMMENT ON POLICY tasks_delete ON tasks IS
    'Tenant isolation: tasks can only DELETE rows in their tenant context (app.current_tenant_id)';

-- ============================================================================
-- PROJECTS TABLE POLICY COMMENTS (Partial - SELECT comment added in migration 006)
-- ============================================================================

COMMENT ON POLICY projects_insert ON projects IS
    'Tenant isolation: projects can only INSERT rows for their tenant context (app.current_tenant_id)';

COMMENT ON POLICY projects_update ON projects IS
    'Tenant isolation: projects can only UPDATE rows in their tenant context. Both USING and WITH CHECK ensure tenant boundary is maintained.';

COMMENT ON POLICY projects_delete ON projects IS
    'Tenant isolation: projects can only DELETE rows in their tenant context (app.current_tenant_id)';

-- Policy comments are visible to database administrators and developers
-- They serve as inline documentation for the security model
-- Query: SELECT * FROM pg_policies WHERE tablename = 'users';
