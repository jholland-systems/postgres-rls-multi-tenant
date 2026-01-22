-- Migration 006: Create projects_select policy with privileged access clause
-- This policy demonstrates advanced RLS: tenant isolation + privileged admin access
-- Privileged access is OFF by default, requires explicit opt-in with audit logging

-- ============================================================================
-- PROJECTS SELECT POLICY (Combined: Tenant Isolation + Privileged Access)
-- ============================================================================

CREATE POLICY projects_select ON projects
    FOR SELECT
    USING (
        -- Normal tenant isolation (primary use case)
        tenant_id = current_setting('app.current_tenant_id', true)::UUID
        OR
        -- Privileged admin access (explicit opt-in, dangerous)
        COALESCE(current_setting('app.is_superadmin', true), 'false') = 'true'
    );

COMMENT ON POLICY projects_select ON projects IS
    'Tenant isolation with privileged access: SELECT returns rows matching tenant context OR if app.is_superadmin=true (for platform analytics/billing). Privileged access MUST be audited.';

-- ============================================================================
-- PRIVILEGED ACCESS DESIGN NOTES
-- ============================================================================

-- Why COALESCE is needed:
--   current_setting(..., true) returns NULL if variable not set
--   NULL = 'true' evaluates to NULL (not FALSE) due to SQL three-valued logic
--   COALESCE(NULL, 'false') = 'false' ensures strict boolean behavior
--   This prevents SQL three-valued logic confusion

-- Why this is dangerous:
--   - Bypasses core tenant isolation guarantee
--   - One bug in authorization logic = cross-tenant data leak
--   - Violates principle of least privilege

-- Why it's still necessary:
--   - Platform-level analytics (e.g., "total projects across all tenants")
--   - Billing aggregation (e.g., "usage by tenant for invoicing")
--   - Audit log queries (e.g., "all admin actions this month")
--   - Customer support tooling (e.g., "view project as support agent")

-- Security guardrails (enforced in application):
--   1. app.is_superadmin NEVER set from user JWT claims alone
--   2. Superadmin must be derived from server-side authorization (DB-backed role/ACL)
--   3. Every privileged request writes an audit log entry (withPrivilegedContext enforces this)
--   4. Audit log write and privileged query in SAME transaction (atomic)
--   5. If audit log write fails, entire privileged operation rolls back

-- Scope note:
--   Privileged access demonstrated on projects table ONLY
--   users and tasks remain strictly tenant-scoped (no privileged override)
--   This limits the threat surface for cross-tenant queries
--   In production, carefully evaluate which tables need privileged access

-- ============================================================================
-- PERFORMANCE NOTE: Sequential Scan for Privileged Queries
-- ============================================================================

-- When app.is_superadmin = 'true', this policy allows cross-tenant queries
-- The query planner CANNOT use the tenant_id index (policy has "... OR true")
-- Result: Sequential Scan on entire projects table

-- This is ACCEPTABLE because:
--   1. Privileged queries are low-volume analytical operations (not user-facing)
--   2. They run on dedicated connection pool (don't compete with user queries)
--   3. Typical use cases: billing aggregation, platform analytics, audit reports
--   4. Expected performance: 100-500ms for full table scan vs 1-5ms for indexed query

-- Optimization strategies (if needed at scale):
--   - Materialized views for common aggregations (refreshed hourly)
--   - Read replicas for analytical queries (offload from primary)
--   - Time-based partitioning for large tables (improves Seq Scan speed)
--   - EXPLAIN ANALYZE to identify slow privileged queries

-- Document this trade-off explicitly in docs/performance.md
