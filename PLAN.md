# Multi-Tenant PostgreSQL RLS - Implementation Plan

## Project Overview

**Purpose**: Production-grade showcase demonstrating multi-tenant data isolation using PostgreSQL Row Level Security (RLS).

**Goal**: Open source GitHub project to demonstrate expertise in database-level tenant isolation for potential employers and collaborators.

**What It Signals**: "I understand data isolation at the database enforcement layer and can implement production-ready multi-tenant architecture."

---

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Language** | TypeScript (Node.js) | Type safety, wide accessibility, great for showcasing |
| **Framework** | Express | **Chosen deliberately for maximal familiarity and lowest framework noise**. Correctness lives in SQL policies + tests, not framework features. |
| **Database** | PostgreSQL 15+ | Mature RLS features, excellent documentation |
| **Query Builder** | Kysely | Type-safe SQL that keeps policies visible (doesn't hide RLS) |
| **Migrations** | node-pg-migrate (SQL-forward) | Migrations are explicit SQL files for maximum clarity |
| **Testing** | Vitest + Testcontainers | Real PostgreSQL in Docker for accurate RLS testing |
| **Dev Environment** | Docker Compose | Easy local setup, reproducible |

---

## Database Architecture

### Multi-Tenancy Pattern
**Shared Schema with Tenant ID** (industry standard for multi-tenant SaaS)

- Single database
- All tables have `tenant_id` column
- RLS policies enforce tenant isolation at database layer
- Session variable pattern: `SET LOCAL app.current_tenant_id`

### Core Schema

**Prerequisites**:

**Migration 000** (pgcrypto extension):
```sql
-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

**Migration 001b** (citext extension):
```sql
-- Enable citext for case-insensitive text (used for email field)
CREATE EXTENSION IF NOT EXISTS citext;
```

**Migration Ordering** (to avoid forward references):
- **Migration 000**: Enable pgcrypto extension
- **Migration 001**: tenants table
- **Migration 001b**: Enable citext extension (required for users.email)
- **Migrations 002-004**: Table creation only. Simple FKs to `tenants(id)` are safe. No cross-table constraints on `projects` or `users`.
- **Migration 004b**: `admin_audit_log` table (no dependencies).
- **Migration 004c**: Timestamp triggers (all tables must exist first).
- **Migration 004d**: Composite FKs + supporting UNIQUE constraints + composite indexes (after all tables exist).
- **Migration 005**: Enable RLS + create policies (after all schema is ready).
- **Migration 006**: Privileged access combined SELECT policy.

**Tables**:
```sql
-- Tenants (no RLS)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),  -- DNS-safe slug format
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prerequisites for users table (Migration 001b)
CREATE EXTENSION IF NOT EXISTS citext;

-- Users (with RLS)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email CITEXT NOT NULL CHECK (position('@' IN email) > 1),  -- Case-insensitive email with validation
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

-- Production note: Email case-insensitivity
-- Using citext extension for email field ensures case-insensitive comparisons
-- (user@example.com == USER@EXAMPLE.COM). This matches industry standard behavior.
-- UNIQUE(tenant_id, email) with citext prevents "user@x.com" and "USER@x.com" as duplicates.

-- Projects (with RLS)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tasks (with RLS)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID NOT NULL,  -- FK added later as composite constraint (tenant_id, project_id)
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked')),
    assigned_to UUID NULL,  -- Tenant-scoped user id (not global). Nullable by design (supports ON DELETE SET NULL in composite FK)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin audit log (no RLS - global tracking of privileged access)
-- Access control: app_user has INSERT only, app_admin has SELECT
-- This prevents sensitive audit log from becoming a data leak vector
CREATE TABLE admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID NOT NULL,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,              -- e.g., 'cross_tenant_query', 'admin_override'
    correlation_id TEXT NOT NULL,      -- Request ID for tracing
    reason TEXT,                        -- Why privileged access was needed
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Contextual data: actor_ip, endpoint, target_tenant_id, query_name, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Access control grants for admin_audit_log (recommended in production)
-- REVOKE ALL ON admin_audit_log FROM PUBLIC;
-- GRANT INSERT ON admin_audit_log TO app_user;
-- GRANT SELECT ON admin_audit_log TO app_admin;

-- Critical indexes for performance
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log(created_at);
CREATE INDEX idx_admin_audit_log_actor_id ON admin_audit_log(actor_id);
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
-- Note: UNIQUE(tenant_id, email) already creates a unique btree index; no separate index needed
CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX idx_projects_tenant_status ON projects(tenant_id, status);  -- Common filtering pattern
CREATE INDEX idx_tasks_tenant_id ON tasks(tenant_id);
CREATE INDEX idx_tasks_tenant_status ON tasks(tenant_id, status);  -- Common filtering in task lists

-- Tenant boundary enforcement with composite foreign keys
-- This prevents tasks from referencing projects/users in different tenants
-- (Defense-in-depth beyond RLS)
-- Note: project_id and assigned_to defined WITHOUT simple FKs in table creation
-- Composite FKs added here enforce tenant boundary at constraint level

ALTER TABLE projects
    ADD CONSTRAINT projects_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE tasks
    ADD CONSTRAINT tasks_tenant_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects (tenant_id, id)
    ON DELETE CASCADE;

-- Same pattern for user assignment (tenant boundary enforcement)
ALTER TABLE users
    ADD CONSTRAINT users_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE tasks
    ADD CONSTRAINT tasks_tenant_assigned_to_fk
    FOREIGN KEY (tenant_id, assigned_to)
    REFERENCES users (tenant_id, id)
    ON DELETE SET NULL;  -- Allow unassigned tasks

-- Indexes for composite FK performance (join and FK enforcement lookups)
CREATE INDEX idx_tasks_tenant_project_id ON tasks(tenant_id, project_id);
CREATE INDEX idx_tasks_tenant_assigned_to ON tasks(tenant_id, assigned_to);

-- Production note: For large existing tables, use NOT VALID then VALIDATE CONSTRAINT
-- to avoid long locks during FK addition:
--   ALTER TABLE tasks ADD CONSTRAINT ... NOT VALID;
--   ALTER TABLE tasks VALIDATE CONSTRAINT tasks_tenant_project_fk;
-- For this demo with empty tables, NOT VALID is unnecessary.

-- Timestamp maintenance: updated_at trigger
-- Explicitly scoped and search_path secured for production safety
-- Note: SECURITY DEFINER intentionally omitted (unnecessary for triggers; would increase blast radius)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Apply trigger to all tables with updated_at (with idempotency for dev resets)
DROP TRIGGER IF EXISTS update_tenants_updated_at ON tenants;
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;
CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**Why Composite Foreign Keys**: Composite FKs enforce tenant boundaries at the constraint level. Without this, a task could reference a project or user from a different tenant (RLS would hide it in queries, but the FK would exist in the database). This is defense-in-depth: even if RLS is disabled or bypassed, the constraint prevents cross-tenant linkage. We apply this pattern consistently to all cross-table references.

**Key Design Choices**:
- UUID IDs (prevents enumeration attacks)
- `tenant_id` on every multi-tenant table (explicit tenant association)
- Foreign key constraints with cascade deletes (data integrity + clean tenant removal)
- Timestamps (audit trail)
- Tenant-scoped uniqueness constraints (e.g., UNIQUE(tenant_id, email))
- Composite FKs for cross-table references (tenant boundary enforcement)

**Production Database Role Model** (intended privilege separation):

In a production deployment, the database privilege model should be:
- **Application role** (`app_user`): Has DML (SELECT, INSERT, UPDATE, DELETE) only on tenant tables. No DDL, no schema ownership, **no BYPASSRLS**.
- **Admin role** (`app_admin`): Separate role for privileged operations. Has SELECT across all tenants. All usage audited. Not granted to normal application connections.
- **Migration role** (`app_migrations`): Separate role for schema changes. Owns tables. Can execute DDL. Used only during deployments, not at runtime.
- **Superuser/owner**: Never used by application code. Reserved for emergency operations with explicit, time-bounded elevation.

**Why this matters**: Application code cannot accidentally bypass RLS. Schema ownership is separated from runtime operations. Migrations run under a dedicated identity.

**For this showcase**: We use a simplified connection model for ease of demonstration, but document the production-grade privilege separation pattern in `docs/architecture.md`.

**Operational Note on FORCE RLS**: With `FORCE ROW LEVEL SECURITY` enabled, **even table owners respect RLS policies** (unless they have BYPASSRLS attribute). This means:
- Maintenance tasks (data backfills, repairs) must be RLS-aware or run with explicit elevation
- Operational scripts should execute under a dedicated role with time-bounded, audited privilege escalation
- We **never grant BYPASSRLS to the normal application role** - it defeats the purpose of RLS
- If a task truly needs to bypass RLS (e.g., cross-tenant data migration), it runs under `app_migrations` role with explicit logging

---

### RLS Policies

**Critical Safety Pattern**: Missing tenant context = zero rows (fail closed)

**Policy Naming Convention**: `<table>_<operation>` (e.g., `users_select`, `projects_insert`)

**Migration Structure**:
- **Migration 005** (`005_enable_rls.sql`): Enable + FORCE RLS on all tables. Create complete policy set for `users` and `tasks`. Create INSERT/UPDATE/DELETE policies for `projects`.
- **Migration 006** (`006_privileged_access.sql`): Create `projects_select` combined policy with privileged access clause.

**Canonical Policy Set**:

```sql
-- Enable RLS and FORCE it (prevents table owners from bypassing RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

-- Users table policies (complete set in migration 005)
-- IMPORTANT: Use current_setting(..., true) for "missing-safe" behavior
-- If tenant context is not set, returns NULL, comparisons fail, returns zero rows
CREATE POLICY users_select ON users
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY users_insert ON users
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY users_update ON users
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY users_delete ON users
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- Tasks table policies (complete set in migration 005)
CREATE POLICY tasks_select ON tasks
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY tasks_insert ON tasks
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY tasks_update ON tasks
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY tasks_delete ON tasks
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- Projects table: INSERT/UPDATE/DELETE in migration 005, SELECT in migration 006
CREATE POLICY projects_insert ON projects
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY projects_update ON projects
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY projects_delete ON projects
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);
```

**Why `FORCE ROW LEVEL SECURITY`**: FORCE prevents table owners from bypassing RLS. Superusers and roles with BYPASSRLS can still bypass RLS (as designed).

**Why `current_setting(..., true)`**: The second parameter means "missing-ok". If tenant context is not set, returns NULL instead of erroring. Since `NULL = anything` is false in SQL, policies return zero rows. This is **fail-closed** behavior.

**App-layer enforcement**: Still validate tenant context at middleware layer (return 401/403 early). The DB policies are defense-in-depth.

**⚠️ RLS is not a substitute for authorization**: RLS provides tenant isolation (data segmentation), not authentication or authorization. The application still validates identity and permissions. RLS is defense-in-depth enforcement, not a replacement for app-layer security.

**Type Safety for `::UUID` Cast**: If an invalid (non-UUID) string is set in `app.current_tenant_id`, the `::UUID` cast will error. This is acceptable fail-closed behavior (query errors instead of returning wrong data). **Middleware validates UUID format before setting GUC** to prevent noisy 500 errors from malformed tenant context.

**Policy Composition Note**: PostgreSQL policies are **permissive by default** (OR semantics). We use single policies per operation to avoid accidental widening.

**LEAKPROOF Functions in Policies** (Critical Security Detail):

If you use custom functions in RLS policies, they **MUST be marked LEAKPROOF** to prevent side-channel data leakage through error messages.

**The vulnerability**:
```sql
-- BAD: Non-leakproof function in policy
CREATE FUNCTION is_tenant_admin(tid UUID) RETURNS BOOLEAN AS $$
BEGIN
    -- If this function throws an error with tenant-specific details,
    -- an attacker could learn about other tenants' data through error messages
    RETURN EXISTS (SELECT 1 FROM tenant_admins WHERE tenant_id = tid);
END;
$$ LANGUAGE plpgsql;  -- NOT LEAKPROOF by default

CREATE POLICY users_select ON users
    FOR SELECT
    USING (is_tenant_admin(tenant_id));  -- Potential side-channel leak!
```

**Attack scenario**: Attacker could craft inputs to trigger errors in `is_tenant_admin()` and learn about other tenants through error message differences (timing, error text, etc.).

**The fix**:
```sql
-- GOOD: Mark function as LEAKPROOF
CREATE FUNCTION is_tenant_admin(tid UUID) RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM tenant_admins WHERE tenant_id = tid);
END;
$$ LANGUAGE plpgsql LEAKPROOF;  -- ✅ Prevents side-channel leaks

-- Alternatively, use inline SQL expressions (automatically safe)
CREATE POLICY users_select ON users
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);  -- No function, no leak
```

**Key points**:
- Built-in functions (`=`, `AND`, `OR`, `current_setting`) are already LEAKPROOF
- Custom functions must be explicitly marked LEAKPROOF
- Only superusers can mark functions LEAKPROOF (it's a security certification)
- LEAKPROOF functions must not reveal information through errors or side effects

**For this showcase**: Our policies use inline SQL expressions only (no custom functions), so LEAKPROOF is not needed. We document this pattern in `docs/rls-policies.md` for production codebases that use custom policy functions.

**Advanced Pattern - RESTRICTIVE Policies** (optional, for complex access patterns):
```sql
-- Permissive policy grants access (OR'd together)
CREATE POLICY projects_tenant_access ON projects AS PERMISSIVE
    FOR SELECT USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- Restrictive policy further constrains (AND'd with permissive)
CREATE POLICY projects_no_archived_for_members AS RESTRICTIVE
    FOR SELECT USING (
        status != 'archived'
        OR current_setting('app.user_role', true) = 'admin'
    );
```
With RESTRICTIVE, users must satisfy ALL restrictive policies AND at least one permissive policy. This prevents accidental widening when adding new policies. For this showcase, single permissive policies are clearer. See `docs/rls-policies.md` for RESTRICTIVE policy patterns.

### Privileged Access Pattern (Advanced Feature)

**Purpose**: Enable cross-tenant queries for platform administration with explicit opt-in.

**⚠️ Why this is dangerous**:
- Bypasses the core isolation guarantee
- One bug = cross-tenant data leak
- Violates principle of least privilege

**Why it's still necessary**:
- Platform-level analytics (total projects across all tenants)
- Billing aggregation
- Audit log queries
- Customer support tooling

**Implementation principle**: Off by default, explicit opt-in only.

**Policy Pattern** (Session Variable Approach):

```sql
-- Combined SELECT policy with privileged clause (Migration 006)
-- NOTE: INSERT/UPDATE/DELETE policies for projects are in Canonical Policy Set above
-- This combined SELECT policy includes tenant isolation + privileged access
-- IMPORTANT: app.is_superadmin is ONLY set after server-side authorization check
-- (never from JWT claims alone). Missing tenant context still returns 401/403 at API layer.
CREATE POLICY projects_select ON projects
    FOR SELECT
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::UUID
        OR COALESCE(current_setting('app.is_superadmin', true), 'false') = 'true'
    );
```

**Performance Note on Privileged Queries**: When `app.is_superadmin = 'true'`, this policy allows cross-tenant queries (`USING (... OR true)`). PostgreSQL query planner **cannot use the tenant_id index** for this case and will perform a **Sequential Scan** on the entire table. This is acceptable because:
1. Administrative cross-tenant queries are low-volume analytical operations (not user-facing traffic)
2. They run on dedicated connection pool (don't compete with user queries)
3. Typical queries: billing aggregation, platform analytics, audit reports
4. Expected performance: 100-500ms for full table scan (vs 1-5ms for indexed tenant query)

**Optimization for privileged queries** (if needed at scale):
- Materialized views for common aggregations (refresh hourly)
- Read replicas for analytical queries (offload from primary)
- Time-based partitioning for audit/analytics tables
- EXPLAIN ANALYZE to identify slow paths

Document this trade-off explicitly in `docs/performance.md`.

**Scope Note**: **Privileged cross-tenant access is demonstrated on `projects` only to keep the threat surface small**. `users` and `tasks` remain strictly tenant-scoped (no privileged override). This is intentional design: limit privileged access to the minimum necessary surface area. In production, you would carefully evaluate which tables need cross-tenant queries and grant privileged access sparingly.

**Important Notes**:
- Policies are additive (OR'd). We use a single SELECT policy with both clauses to avoid ambiguity.
- GUCs are strings: use `= 'true'` not `::boolean = true` for clarity
- **COALESCE for NULL-safety**: `current_setting(..., true)` returns NULL if unset. Since `NULL = 'true'` evaluates to NULL (not false), we use COALESCE to avoid SQL three-valued logic confusion. This makes the policy strictly boolean.
- Privileged access only applies to SELECT (read-only cross-tenant queries). INSERT/UPDATE/DELETE policies (shown in Canonical Policy Set) remain tenant-scoped only.
- **Migration order**: Migration 005 creates INSERT/UPDATE/DELETE policies for projects (and all policies for users/tasks). Migration 006 adds this combined SELECT policy for projects. This avoids creating then dropping policies.

**Stronger Pattern (RECOMMENDED for Production)**: Role-based privileged access

**Why this is stronger**: Database roles provide **enforcement at connection level**, not just application logic. Even if application code is compromised, it cannot escalate privileges without database credentials.

Instead of relying solely on session variable (which app controls), use database roles:

```sql
-- Create roles with clear separation
CREATE ROLE app_user;         -- Normal application access (RLS enforced)
CREATE ROLE app_readonly_admin; -- Platform admin (read-only cross-tenant, audited)

-- Grant base access
GRANT CONNECT ON DATABASE multitenantdb TO app_user, app_readonly_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly_admin;  -- Read-only

-- Default policy: enforce tenant isolation for app_user
CREATE POLICY tenant_isolation ON projects
    FOR ALL
    TO app_user
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- Privileged policy: admin can see all (explicit, read-only)
CREATE POLICY admin_readonly_access ON projects
    FOR SELECT
    TO app_readonly_admin
    USING (true);  -- See all tenants

-- No INSERT/UPDATE/DELETE policies for app_readonly_admin
-- (prevents admin from modifying data across tenants)
```

**Application implementation**:
```typescript
// Two separate connection pools
const userPool = new Pool({
    user: 'app_user',
    // ... connection config
});

const adminPool = new Pool({
    user: 'app_readonly_admin',
    // ... connection config
});

// Normal endpoints use userPool
app.get('/projects', async (req, res) => {
    const client = await userPool.connect();
    try {
        await client.query('SET LOCAL app.current_tenant_id = $1', [req.tenantId]);
        const result = await client.query('SELECT * FROM projects');
        res.json(result.rows);
    } finally {
        client.release();
    }
});

// Admin endpoints use adminPool (with audit logging)
app.get('/admin/all-projects', requireAdmin, async (req, res) => {
    const client = await adminPool.connect();
    try {
        // No tenant context - admin can see all
        // Log privileged access
        await auditLog.insert({
            actor: req.user.id,
            action: 'admin_cross_tenant_query',
            correlation_id: req.correlationId,
            reason: req.body.reason,  // Required field
        });
        const result = await client.query('SELECT * FROM projects');
        res.json(result.rows);
    } finally {
        client.release();
    }
});
```

**Benefits of role-based approach**:
- ✅ **Privilege separation at connection level** (even compromised app can't escalate)
- ✅ **Read-only admin** (prevents accidental cross-tenant writes)
- ✅ **Explicit credential management** (admin credentials stored separately, rotated independently)
- ✅ **Connection pool isolation** (admin requests don't consume user connection pool)
- ✅ **Audit at connection establishment** (every admin pool checkout is logged)
- ✅ **PostgreSQL-native enforcement** (no application logic to bypass)

**Why this is "staff+ level"**: Most RLS implementations stop at session variables. Role-based separation demonstrates **defense-in-depth thinking** and understanding of database privilege models.

**For this showcase**: We'll implement session-variable approach (simpler, easier to understand) but **prominently document role-based alternative** in `docs/architecture.md` with full implementation guide. This shows "I know the right way for production, but chose simplicity for demo."

**Audit Logging** (DB-level guardrail):

Every privileged request writes an audit log row within the same transaction. Schema defined in migration 004b (see Core Schema section above).

**Application implementation**:
- When middleware sets `app.is_superadmin = 'true'`, it also inserts an audit row
- Every privileged query includes actor, reason, and correlation ID
- Audit log is queryable for security reviews and compliance

**Design choice**: Audit at application layer (not DB trigger) for richer context (actor identity, reason, correlation ID). Document this as explicit defense-in-depth.

**Guardrails**:
1. Never set `app.is_superadmin` from user JWT claims alone
2. **Superadmin must be derived from server-side authorization** (DB-backed role/ACL), not a token claim. Claims are inputs, not authority.
3. Require explicit admin endpoint + audit log entry for every privileged operation
4. **Every privileged request writes an audit log row** including actor, reason, and correlation ID (within same transaction)
5. Document every privileged access code path:
   - Why it needs cross-tenant access
   - What happens if compromised
   - How it's audited

---

## Application Architecture

### Why SET LOCAL (Critical Design Decision)

**We intentionally use `SET LOCAL` instead of `SET` to guarantee tenant context is scoped to the current transaction and cannot leak across pooled connections.**

This is critical because:
- `SET` persists for the session lifetime
- Connection pooling reuses connections across requests
- `SET` would leak tenant context between requests
- `SET LOCAL` automatically resets when transaction ends

Example failure mode with `SET`:
```
Request 1 (Tenant A): SET app.current_tenant_id = 'tenant-a-uuid'
Request 1 completes, connection returns to pool
Request 2 (Tenant B): Gets same connection from pool
Request 2: Queries run as Tenant A (!!)
```

`SET LOCAL` prevents this by scoping to transaction lifetime only.

### Connection Pool Safety (Advanced: Poolers and External Connection Managers)

**The Problem**: External connection poolers (PgBouncer, AWS RDS Proxy, Supavisor) operate in transaction-pooling or statement-pooling mode. In these modes, connections are returned to the pool **immediately after transaction commit**, and the next transaction on that connection may come from a different client.

**Risks**:
1. **Leaked Session State**: If a transaction fails after `SET LOCAL` but before commit/rollback, some poolers may not automatically RESET session state
2. **Prepared Statement Leakage**: Named prepared statements persist across transactions in session-pooling mode
3. **Temporary Table Leakage**: Session-scoped temp tables can leak if transaction cleanup fails

**Mitigation (Defense-in-Depth)**:

**Pattern 1: DISCARD ALL on connection reset** (strongest, but high overhead)
```typescript
// After every transaction failure, discard all session state
try {
    await tx.commit();
} catch (err) {
    await tx.rollback();
    // Expensive but safe: reset all session state
    await db.execute(sql`DISCARD ALL`);
    throw err;
}
```

**Pattern 2: Connection validator (production-grade)**
```typescript
// Before returning connection to pool, validate it's clean
pool.on('release', async (connection) => {
    // Check for leaked session variables
    const result = await connection.query(
        "SELECT current_setting('app.current_tenant_id', true)"
    );
    if (result.rows[0]?.current_setting !== null) {
        logger.error('LEAKED TENANT CONTEXT DETECTED', { connection });
        // Destroy connection instead of returning to pool
        connection.destroy();
    }
});
```

**Pattern 3: SET LOCAL with explicit RESET** (balanced approach)
```typescript
async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: Transaction) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        try {
            await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
            return await callback(tx);
        } finally {
            // Explicit cleanup even though SET LOCAL should auto-reset
            // Defense-in-depth for pooler edge cases
            try {
                await tx.execute(sql`RESET app.current_tenant_id`);
            } catch {
                // Ignore RESET errors (transaction may already be rolled back)
            }
        }
    });
}
```

**For this showcase**: We use Pattern 3 (SET LOCAL with explicit RESET) as the primary pattern, document Patterns 1-2 in `docs/architecture.md` for production deployments with external poolers.

**Production Recommendation**: If using PgBouncer in transaction-pooling mode, enable `server_reset_query = DISCARD ALL` in pgbouncer.ini to force session cleanup on connection reset. This adds ~1ms overhead per transaction but prevents all session state leakage.

### Scoped Database Factory (Preventing the "Naked Query" Trap)

**The Problem**: With per-handler transaction wrappers, developers might accidentally use the base `db` instance instead of the transaction-scoped `tx` instance, bypassing tenant context entirely.

**Example failure mode**:
```typescript
// WRONG: Uses base db instead of tx - bypasses RLS!
async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: Transaction) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
        // But developer uses `db` in the callback:
        return await callback(tx);
    });
}

// In handler:
app.get('/projects', async (req, res) => {
    const projects = await withTenantContext(req.tenantId, async (tx) => {
        // BUG: Uses `db` not `tx` - no tenant context set!
        return await db.selectFrom('projects').selectAll().execute();
    });
    res.json(projects);
});
```

**Solution: Scoped Database Factory**

**Pattern 1: Don't export base db instance** (strongest enforcement)
```typescript
// src/database/client.ts
const db = new Kysely<Database>({ /* ... */ });

// NEVER export `db` directly
// export { db };  ❌ Don't do this

// Instead, only export factory functions
export async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: Kysely<Database>) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
        return await callback(tx);
    });
}

// For non-tenant queries (tenants table itself)
export async function withDatabase<T>(
    callback: (db: Kysely<Database>) => Promise<T>
): Promise<T> {
    return await callback(db);
}
```

**Pattern 2: Runtime validation** (catches mistakes early)
```typescript
// Wrap Kysely to track if tenant context is set
class TenantAwareKysely extends Kysely<Database> {
    private tenantContextSet = false;

    async setTenantContext(tenantId: string) {
        await this.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
        this.tenantContextSet = true;
    }

    // Override selectFrom to check tenant context
    selectFrom<T extends keyof Database>(table: T) {
        const tenantTables = ['users', 'projects', 'tasks'];
        if (tenantTables.includes(table as string) && !this.tenantContextSet) {
            throw new Error(
                `Tenant context not set for query on ${table}. Use withTenantContext().`
            );
        }
        return super.selectFrom(table);
    }
}
```

**Pattern 3: Type system enforcement** (compile-time safety)
```typescript
// Brand the transaction type so it can't be confused with base db
type TenantScopedDB = Kysely<Database> & { __tenantScoped: true };

export async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: TenantScopedDB) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
        // Cast to branded type
        return await callback(tx as TenantScopedDB);
    });
}

// Now handlers MUST use the branded type
app.get('/projects', async (req, res) => {
    const projects = await withTenantContext(req.tenantId, async (tx: TenantScopedDB) => {
        // TypeScript won't let you use `db` here - must use `tx`
        return await tx.selectFrom('projects').selectAll().execute();
    });
    res.json(projects);
});
```

**For this showcase**: We implement Pattern 1 (don't export base db) as the primary pattern, document Patterns 2-3 in `docs/architecture.md` as alternatives. Pattern 1 is simplest and most foolproof.

**Concrete Implementation** (Pattern 1 - Primary):

**`src/database/client.ts`** (Phase 1):
```typescript
import { Kysely, PostgresDialect, Transaction, CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { Database } from './schema'; // Generated types

// 1. The Raw Pool (Internal use only)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    statement_timeout: 10000, // 10s timeout prevents runaway queries from blocking pool
    // Production-ready: Prevents long-running queries from exhausting connection slots
    // Especially important during migrations and analytics queries
});

// 2. The Base Kysely Instance (Internal use only - NOT EXPORTED)
const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
});

// 3. Define a "Branded Type" for the Transaction
// This prevents developers from passing raw 'db' where 'tx' is expected at compile time
export type TenantTransaction = Transaction<Database> & { __brand: 'tenant-aware' };

// 4. Export ONLY the Factory (Primary Pattern)
export async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: TenantTransaction) => Promise<T>
): Promise<T> {
    return await db.transaction().execute(async (tx) => {
        try {
            // A. Set tenant context
            await tx.executeQuery(
                CompiledQuery.raw('SET LOCAL app.current_tenant_id = $1', [tenantId])
            );

            // B. Run callback with branded transaction
            return await callback(tx as TenantTransaction);
        } finally {
            // C. Safety cleanup (defense in depth)
            try {
                await tx.executeQuery(CompiledQuery.raw('RESET app.current_tenant_id'));
                await tx.executeQuery(CompiledQuery.raw('RESET app.is_superadmin'));
            } catch {
                // Ignore - transaction may be rolled back
            }
        }
    });
}

// 5. System Transaction (For non-tenant operations like creating tenants)
export async function withSystemContext<T>(
    callback: (db: Kysely<Database>) => Promise<T>
): Promise<T> {
    // System operations don't set tenant context
    // Use for: tenant CRUD, platform-level operations
    return await callback(db);
}

// 6. Privileged Access (Explicit opt-in for admin queries)
export async function withPrivilegedContext<T>(
    actorId: string,
    actorEmail: string,
    correlationId: string,
    reason: string,
    callback: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
    return await db.transaction().execute(async (tx) => {
        try {
            // Set superadmin flag (no tenant_id)
            await tx.executeQuery(
                CompiledQuery.raw("SET LOCAL app.is_superadmin = 'true'")
            );

            // CRITICAL: Audit log MUST be written in same transaction
            await tx.insertInto('admin_audit_log')
                .values({
                    actor_id: actorId,
                    actor_email: actorEmail,
                    action: 'privileged_cross_tenant_query',
                    correlation_id: correlationId,
                    reason: reason,
                    metadata: JSON.stringify({
                        timestamp: new Date().toISOString(),
                    }),
                })
                .execute();

            return await callback(tx);
        } finally {
            try {
                await tx.executeQuery(CompiledQuery.raw('RESET app.is_superadmin'));
            } catch {
                // Ignore
            }
        }
    });
}
```

**Why this works**:
- Base `db` instance is **never exported** (can't be misused)
- All route handlers **must** use `withTenantContext()` or `withSystemContext()`
- Branded type `TenantTransaction` provides compile-time safety
- TypeScript will error if you try to pass `db` where `TenantTransaction` is expected

**Usage in handlers** (Phase 4):
```typescript
// Tenant-scoped endpoint
app.get('/api/projects', async (req, res) => {
    const projects = await withTenantContext(req.tenantId, async (tx) => {
        // tx is TenantTransaction - compiler enforces correct usage
        return await tx.selectFrom('projects').selectAll().execute();
    });
    res.json(projects);
});

// System endpoint (tenant CRUD)
app.post('/api/tenants', async (req, res) => {
    const tenant = await withSystemContext(async (db) => {
        return await db.insertInto('tenants')
            .values({ name: req.body.name, slug: req.body.slug })
            .returningAll()
            .executeTakeFirstOrThrow();
    });
    res.json(tenant);
});

// Privileged endpoint (explicit admin access)
app.get('/admin/all-projects', requireAdmin, async (req, res) => {
    const allProjects = await withPrivilegedContext(
        req.user.id,
        req.user.email,
        req.correlationId,
        req.body.reason, // Admin must provide reason
        async (tx) => {
            // Can query across all tenants
            return await tx.selectFrom('projects').selectAll().execute();
        }
    );
    res.json(allProjects);
});
```

This pattern makes it **impossible to accidentally bypass tenant context** at the code level.

### Tenant Context Middleware

**Recommended Approach**: Per-handler transaction wrappers (shown first, used in implementation)

This is the most practical pattern for production use - transactions are short-lived and commit/rollback semantics are explicit:

```typescript
// Utility for tenant-scoped queries (with explicit RESET for pooler safety)
async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: Transaction) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        try {
            await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
            return await callback(tx);
        } finally {
            // CRITICAL: Reset BOTH variables to prevent privilege leakage
            // If app.is_superadmin was set, it must be cleared before connection returns to pool
            try {
                await tx.execute(sql`RESET app.current_tenant_id`);
                await tx.execute(sql`RESET app.is_superadmin`);  // Prevent admin privilege leakage
            } catch {
                // Ignore RESET errors (transaction may already be rolled back)
            }
        }
    });
}

// For privileged access (explicit opt-in)
async function withPrivilegedContext<T>(
    actorId: string,
    actorEmail: string,
    correlationId: string,
    reason: string,
    callback: (tx: Transaction) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        try {
            // Set privileged flag (NO tenant context)
            await tx.execute(sql`SET LOCAL app.is_superadmin = 'true'`);

            // Audit log MUST be written within same transaction
            await tx.insertInto('admin_audit_log')
                .values({
                    actor_id: actorId,
                    actor_email: actorEmail,
                    action: 'privileged_cross_tenant_query',
                    correlation_id: correlationId,
                    reason: reason,
                    metadata: JSON.stringify({ timestamp: new Date().toISOString() })
                })
                .execute();

            return await callback(tx);
        } finally {
            try {
                await tx.execute(sql`RESET app.is_superadmin`);
            } catch {
                // Ignore RESET errors
            }
        }
    });
}

// Usage in route handlers
app.get('/projects', async (req, res) => {
    const projects = await withTenantContext(req.tenantId, async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
    });
    res.json(projects);
});

app.post('/projects', async (req, res) => {
    const project = await withTenantContext(req.tenantId, async (tx) => {
        return await tx.insertInto('projects')
            .values({ ...req.body, tenant_id: req.tenantId })
            .returningAll()
            .executeTakeFirstOrThrow();
    });
    res.status(201).json(project);
});
```

**Benefits**:
- Transaction lifetime matches operation scope
- Commit/rollback is automatic (no manual finalization)
- Shorter connection hold time
- Easier to reason about correctness
- Standard pattern in most frameworks

**Alternative: Request-Scoped Transaction** (illustrative, not recommended for production)

For demonstration purposes, we document the request-scoped pattern but with correct commit semantics:

```typescript
// Request-scoped transaction lifecycle (correct-by-default)
app.use(async (req, res, next) => {
    const tenantId = extractTenantFromJWT(req);
    const isSuperadmin = checkSuperadminRole(req);

    let tx: Transaction;
    let finalized = false;

    try {
        tx = await db.beginTransaction();

        await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);

        if (isSuperadmin) {
            await tx.execute(sql`SET LOCAL app.is_superadmin = 'true'`);
        }

        req.db = tx;
        res.locals.txShouldCommit = false; // Default: rollback

        const finalizeTransaction = async () => {
            if (finalized) return;
            finalized = true;

            try {
                if (res.locals.txShouldCommit) {
                    await tx.commit();
                } else {
                    await tx.rollback();
                }
            } catch (err) {
                logger.error('Transaction finalization error', { err });
                if (res.locals.txShouldCommit) {
                    try { await tx.rollback(); } catch { /* ignore */ }
                }
            }
        };

        res.once('finish', finalizeTransaction);
        res.once('close', finalizeTransaction);

        next();
    } catch (err) {
        if (tx && !finalized) {
            finalized = true;
            try { await tx.rollback(); } catch { /* ignore */ }
        }
        next(err);
    }
});

// Handlers must explicitly mark success
app.get('/projects', async (req, res) => {
    const projects = await req.db.selectFrom('projects').selectAll().execute();
    res.locals.txShouldCommit = true; // Explicit success flag
    res.json(projects);
});
```

**Why per-handler is better**:
- Request-scoped transactions hold connections for entire request (inefficient)
- Long-running requests can exhaust connection pool
- Request scope doesn't map to business transaction boundaries
- Requires explicit success tracking (`txShouldCommit`)
- More complex error handling

**For this showcase**: We'll use per-handler transaction wrappers as the primary pattern, with request-scoped documented in `docs/architecture.md` as an alternative.

**⚠️ Beware SECURITY DEFINER and views**: Views and SECURITY DEFINER functions can unintentionally bypass RLS depending on ownership and role context. This repo avoids them and documents safe usage patterns in `docs/architecture.md`. When using SECURITY DEFINER, ensure the function respects tenant context explicitly.

---

## Single-Point-of-Failure Analysis

This section documents "what happens when X fails" - critical thinking that demonstrates production-grade security design.

### Failure Scenario 1: Middleware Bypass

**What if**: An attacker finds a route that doesn't go through tenant context middleware?

**Example**:
```typescript
// OOPS: Forgot middleware on this route
app.get('/debug/all-projects', async (req, res) => {
    const projects = await db.selectFrom('projects').selectAll().execute();
    res.json(projects);
});
```

**What happens**:
- Request reaches handler without `SET LOCAL app.current_tenant_id`
- Query executes with NULL tenant context
- RLS policies: `tenant_id = current_setting('app.current_tenant_id', true)::UUID`
- `current_setting(..., true)` returns NULL (missing-safe mode)
- `tenant_id = NULL` evaluates to NULL (SQL three-valued logic)
- WHERE clause rejects all rows → **zero rows returned**

**Defense-in-depth result**: ✅ **Fail-closed** - attacker gets empty array, not all data

**Additional safeguards**:
1. Lint rule to ensure all routes use middleware (enforce at CI)
2. Integration test: attempt query without tenant context, expect empty result
3. Audit log monitoring: alert on queries with missing tenant context

### Failure Scenario 2: Developer Forgets WHERE Clause

**What if**: Developer writes a query without explicit `WHERE tenant_id = ?`

**Example**:
```typescript
// Developer writes sloppy query
const projects = await tx
    .selectFrom('projects')
    .selectAll()
    .execute();  // No WHERE clause!
```

**What happens**:
- Transaction has `SET LOCAL app.current_tenant_id = 'tenant-a-uuid'`
- Query executes: `SELECT * FROM projects`
- **RLS policies automatically inject**: `WHERE tenant_id = 'tenant-a-uuid'`
- Query planner adds RLS filter before returning rows
- Only Tenant A's projects returned

**Defense-in-depth result**: ✅ **RLS enforces isolation even with sloppy queries**

**This is the core value of RLS**: Isolation is **enforced at the database layer**, not dependent on every developer writing perfect WHERE clauses.

**Why explicit WHERE is still recommended**:
- Query performance: explicit WHERE can use indexes more efficiently
- Code clarity: makes intent obvious to reviewers
- Defense-in-depth: don't rely solely on RLS

**Best practice**: Write queries with explicit `WHERE tenant_id = ${tenantId}` AND rely on RLS as safety net.

### Failure Scenario 3: JWT Compromise

**What if**: Attacker steals a valid JWT for Tenant A?

**What happens**:
1. Attacker sends requests with stolen Tenant A JWT
2. Middleware extracts Tenant A's ID from JWT
3. `SET LOCAL app.current_tenant_id = 'tenant-a-uuid'`
4. RLS policies enforce Tenant A isolation
5. Attacker can access **Tenant A's data only** (not Tenant B, C, etc.)

**Impact**: ✅ **Blast radius limited to single tenant**

**Contrast with naive approach** (no RLS):
- If JWT contained `{ role: 'admin', canAccessAllTenants: true }`, attacker could access ALL data
- Without RLS, compromise of one tenant = compromise of entire platform

**Why this matters**: RLS **isolates the blast radius of credential compromise**. Even with valid auth, users cannot escape their tenant boundary.

**Additional safeguards**:
- Short JWT expiration (15 min access token + refresh token pattern)
- JWT revocation list for compromised tokens
- Anomaly detection (unusual access patterns)
- Rate limiting per tenant

### Failure Scenario 4: SQL Injection with RLS

**What if**: App has SQL injection vulnerability?

**Example**:
```typescript
// OOPS: SQL injection vulnerability
const userId = req.query.userId;  // Not validated!
const user = await tx.execute(
    sql.raw(`SELECT * FROM users WHERE id = '${userId}'`)  // String interpolation!
);
```

**What an attacker might try**:
```
GET /api/users?userId=xxx' OR tenant_id = 'other-tenant-uuid' --
```

**What happens**:
1. Injected SQL: `SELECT * FROM users WHERE id = 'xxx' OR tenant_id = 'other-tenant-uuid' --'`
2. Transaction has `SET LOCAL app.current_tenant_id = 'attacker-tenant-uuid'`
3. Query executes with injection
4. **RLS policies still apply**: Even though WHERE clause tries to access other tenant, RLS **automatically adds**: `AND tenant_id = current_setting('app.current_tenant_id', true)::UUID`
5. Final effective query: `WHERE (id = 'xxx' OR tenant_id = 'other-tenant-uuid') AND tenant_id = 'attacker-tenant-uuid'`
6. Since `'other-tenant-uuid' != 'attacker-tenant-uuid'`, no rows match

**Defense-in-depth result**: ✅ **SQL injection cannot bypass tenant boundaries**

**Critical understanding**: RLS policies are **enforced by the query planner**, not parsed from SQL text. Even injected SQL cannot remove RLS filters.

**Why this doesn't mean SQL injection is OK**:
- Attacker could still exfiltrate their own tenant's data
- Attacker could DOS the database
- Attacker could corrupt their own tenant's data
- SQL injection is still a critical vulnerability

**Defense-in-depth layers**:
1. **Parameterized queries** (primary defense - prevents injection)
2. **RLS policies** (secondary defense - limits blast radius if injection occurs)
3. **Input validation** (tertiary defense - reject malicious input)

### Failure Scenario 5: Database Role Misconfiguration

**What if**: Application database role has `BYPASSRLS` attribute?

**Example**:
```sql
-- OOPS: Someone granted BYPASSRLS
GRANT app_user TO app_service;
ALTER ROLE app_service BYPASSRLS;
```

**What happens**:
- All RLS policies are **completely bypassed**
- Tenant isolation is **completely broken**
- Any query returns data from all tenants

**Defense-in-depth result**: ❌ **Complete failure - no isolation**

**Why this is a single point of failure**:
- BYPASSRLS is a role attribute (database-level permission)
- If application role has BYPASSRLS, RLS provides zero protection
- This is **the Achilles heel of RLS-based isolation**

**Critical safeguards**:
1. **NEVER grant BYPASSRLS to application role** (document in runbook)
2. Automated check in CI: query `pg_roles` and fail if app role has BYPASSRLS
3. Database audit logging: alert on BYPASSRLS grants
4. Principle of least privilege: only migration role has elevated privileges

**Check script** (run in CI):
```sql
-- Verify app role does NOT have BYPASSRLS
SELECT rolname, rolbypassrls
FROM pg_roles
WHERE rolname = 'app_user';

-- Expected: rolbypassrls = false
-- If true, FAIL CI build
```

**For this showcase**: We document this check in `docs/rls-safety-checklist.md` and include verification script in `scripts/verify-rls-config.ts`.

### Failure Scenario 6: Transaction Committed Without SET LOCAL

**What if**: Transaction commits but `SET LOCAL` was never called?

**Example**:
```typescript
// OOPS: Developer bypasses withTenantContext wrapper
app.get('/projects', async (req, res) => {
    const projects = await db.transaction(async (tx) => {
        // Forgot to call SET LOCAL!
        return await tx.selectFrom('projects').selectAll().execute();
    });
    res.json(projects);
});
```

**What happens**:
- Transaction executes without tenant context
- RLS policies: `tenant_id = current_setting('app.current_tenant_id', true)::UUID`
- `current_setting(..., true)` returns NULL
- `tenant_id = NULL` → FALSE for all rows
- **Zero rows returned**

**Defense-in-depth result**: ✅ **Fail-closed** - attacker gets empty array

**Preventive measures**:
1. **Don't export base db instance** (Scoped Database Factory pattern)
2. Runtime validation: throw error if tenant-aware table queried without context
3. Code review: enforce `withTenantContext()` wrapper usage
4. Lint rule: disallow direct `db.transaction()` calls in route handlers

### Summary: Defense-in-Depth Layers

This architecture provides **multiple overlapping security layers**:

| Layer | Purpose | What it prevents | Failure mode |
|-------|---------|------------------|--------------|
| **Input validation** | Reject malicious input | SQL injection, XSS | Attacker crafts valid-looking malicious input |
| **Parameterized queries** | Prevent SQL injection | SQL injection | Developer uses string concatenation |
| **Middleware validation** | Ensure tenant context exists | Missing tenant queries | Route bypasses middleware |
| **RLS policies (DB)** | Enforce tenant isolation | Cross-tenant access | Role has BYPASSRLS |
| **Composite FKs** | Enforce tenant boundaries in references | Cross-tenant foreign keys | FKs not created for all tables |
| **Audit logging** | Detect suspicious activity | Privilege abuse | Logs not monitored |
| **Role separation** | Limit privilege scope | Privilege escalation | All operations use same role |

**Key insight**: No single layer is perfect. **Defense-in-depth means even if one layer fails, others provide protection.**

**Staff+ thinking**: Don't just implement security - **analyze and document failure modes**. This demonstrates understanding of threat models and operational security.

---

## Architecture Diagrams (docs/architecture.md)

To make the documentation immediately graspable for reviewers, we'll include visual diagrams for the two most complex concepts:

### Diagram 1: Request Lifecycle (Happy Path vs. Attack)

This diagram shows **where fail-closed mechanisms live** and demonstrates defense-in-depth.

**A. Happy Path (Normal Tenant Request)**
```
┌─────────┐      ┌────────────┐      ┌──────────────┐      ┌────────────┐
│ Client  │      │ Middleware │      │   Handler    │      │ PostgreSQL │
└────┬────┘      └─────┬──────┘      └──────┬───────┘      └─────┬──────┘
     │                 │                    │                     │
     │  GET /projects  │                    │                     │
     │────────────────>│                    │                     │
     │                 │ Extract tenant_id  │                     │
     │                 │ from JWT           │                     │
     │                 │ ✅ Valid: tenant-A │                     │
     │                 │                    │                     │
     │                 │  req.tenantId      │                     │
     │                 │───────────────────>│                     │
     │                 │                    │  BEGIN              │
     │                 │                    │────────────────────>│
     │                 │                    │                     │
     │                 │                    │  SET LOCAL          │
     │                 │                    │  app.current_tenant │
     │                 │                    │  = 'tenant-a-uuid'  │
     │                 │                    │────────────────────>│
     │                 │                    │                     │
     │                 │                    │  SELECT * FROM      │
     │                 │                    │  projects           │
     │                 │                    │────────────────────>│
     │                 │                    │                     │
     │                 │                    │  (RLS applied:      │
     │                 │                    │   WHERE tenant_id=  │
     │                 │                    │   'tenant-a-uuid')  │
     │                 │                    │                     │
     │                 │                    │<────────────────────│
     │                 │                    │  [Tenant A projects]│
     │                 │                    │                     │
     │                 │                    │  COMMIT             │
     │                 │                    │────────────────────>│
     │                 │<───────────────────│                     │
     │<────────────────│  200 OK            │                     │
     │  [JSON response]                     │                     │
     │                                      │                     │
     │                 (Connection returned to pool,              │
     │                  SET LOCAL auto-reset)                     │
```

**B. Attack Path 1: Missing JWT (Middleware Fail-Closed)**
```
┌─────────┐      ┌────────────┐      ┌──────────────┐      ┌────────────┐
│Attacker │      │ Middleware │      │   Handler    │      │ PostgreSQL │
└────┬────┘      └─────┬──────┘      └──────┬───────┘      └─────┬──────┘
     │                 │                    │                     │
     │  GET /projects  │                    │                     │
     │  (No JWT)       │                    │                     │
     │────────────────>│                    │                     │
     │                 │ ❌ Missing token   │                     │
     │                 │                    │                     │
     │<────────────────│                    │                     │
     │  401 Unauthorized                    │                     │
     │                 │                    │                     │
     │             (Request never reaches handler or database)    │
     │             (Fail-closed at Layer 1: Middleware)           │
```

**C. Attack Path 2: Route Bypasses Middleware (RLS Fail-Closed)**
```
┌─────────┐                  ┌──────────────┐      ┌────────────┐
│Attacker │                  │   Handler    │      │ PostgreSQL │
└────┬────┘                  └──────┬───────┘      └─────┬──────┘
     │                              │                     │
     │  GET /debug/all-projects     │                     │
     │  (Route forgot middleware)   │                     │
     │─────────────────────────────>│                     │
     │                              │  BEGIN              │
     │                              │────────────────────>│
     │                              │                     │
     │                              │  (No SET LOCAL!)    │
     │                              │                     │
     │                              │  SELECT * FROM      │
     │                              │  projects           │
     │                              │────────────────────>│
     │                              │                     │
     │                              │  (RLS applied:      │
     │                              │   WHERE tenant_id = │
     │                              │   current_setting(  │
     │                              │   'app.current_     │
     │                              │   tenant_id', true) │
     │                              │   ::UUID)           │
     │                              │                     │
     │                              │  current_setting()  │
     │                              │  returns NULL       │
     │                              │  (missing-safe)     │
     │                              │                     │
     │                              │  NULL = anything    │
     │                              │  → FALSE            │
     │                              │                     │
     │                              │<────────────────────│
     │                              │  [Zero rows]        │
     │                              │                     │
     │                              │  COMMIT             │
     │                              │────────────────────>│
     │<─────────────────────────────│                     │
     │  200 OK: []                  │                     │
     │  (Empty array, no data leak) │                     │
     │                              │                     │
     │         (Fail-closed at Layer 2: RLS Policies)     │
     │         (Attacker sees empty response, not all data)│
```

**C. Attack Path 3: SQL Injection with RLS (Defense-in-Depth)**
```
┌─────────┐      ┌────────────┐      ┌──────────────┐      ┌────────────┐
│Attacker │      │ Middleware │      │   Handler    │      │ PostgreSQL │
└────┬────┘      └─────┬──────┘      └──────┬───────┘      └─────┬──────┘
     │                 │                    │                     │
     │  GET /users?id= │                    │                     │
     │  xxx' OR tenant_│                    │                     │
     │  id='tenant-b'--│                    │                     │
     │────────────────>│                    │                     │
     │                 │ Extract tenant_id  │                     │
     │                 │ (Attacker is       │                     │
     │                 │  tenant-a)         │                     │
     │                 │                    │                     │
     │                 │  req.tenantId      │                     │
     │                 │  = 'tenant-a-uuid' │                     │
     │                 │───────────────────>│                     │
     │                 │                    │  BEGIN              │
     │                 │                    │────────────────────>│
     │                 │                    │                     │
     │                 │                    │  SET LOCAL          │
     │                 │                    │  app.current_tenant │
     │                 │                    │  = 'tenant-a-uuid'  │
     │                 │                    │────────────────────>│
     │                 │                    │                     │
     │                 │                    │  SELECT * FROM users│
     │                 │                    │  WHERE id = 'xxx'   │
     │                 │                    │  OR tenant_id =     │
     │                 │                    │  'tenant-b-uuid'--' │
     │                 │                    │  (INJECTED SQL!)    │
     │                 │                    │────────────────────>│
     │                 │                    │                     │
     │                 │                    │  Query Planner adds:│
     │                 │                    │  AND tenant_id =    │
     │                 │                    │  'tenant-a-uuid'    │
     │                 │                    │  (RLS policy)       │
     │                 │                    │                     │
     │                 │                    │  Final WHERE:       │
     │                 │                    │  (id='xxx' OR       │
     │                 │                    │   tenant_id=        │
     │                 │                    │   'tenant-b')       │
     │                 │                    │  AND tenant_id=     │
     │                 │                    │  'tenant-a'         │
     │                 │                    │                     │
     │                 │                    │  'tenant-a' ≠       │
     │                 │                    │  'tenant-b'         │
     │                 │                    │  → No rows match    │
     │                 │                    │                     │
     │                 │                    │<────────────────────│
     │                 │                    │  [Zero rows]        │
     │                 │                    │                     │
     │                 │                    │  COMMIT             │
     │                 │                    │────────────────────>│
     │                 │<───────────────────│                     │
     │<────────────────│                    │                     │
     │  200 OK: []     │                    │                     │
     │                 │                    │                     │
     │         (SQL injection prevented by parameterized queries) │
     │         (Even if injection succeeds, RLS prevents cross-   │
     │          tenant access at query planner level)             │
     │         (Defense-in-Depth: Layer 1 AND Layer 2)            │
```

### Diagram 2: Connection Pooling Risk (Session Scope vs. Transaction Scope)

This visual clarifies **why SET LOCAL is critical** and prevents tenant context leakage.

**A. Dangerous: Session-Scoped Variables (SET without LOCAL)**
```
Connection #42 Lifecycle (Pooled):

┌─────────────────────────────────────────────────────────────────┐
│                          Connection #42                         │
│                    (Stays alive, reused by pool)                │
└─────────────────────────────────────────────────────────────────┘

Request 1 (Tenant A):
  │
  ├─→ SET app.current_tenant_id = 'tenant-a-uuid'  (Session scope!)
  ├─→ SELECT * FROM projects  → Returns Tenant A projects ✅
  └─→ COMMIT
       │
       └─→ Connection returned to pool
           (Session variable STILL SET to 'tenant-a-uuid'!)

Request 2 (Tenant B):
  │  (Gets Connection #42 from pool)
  │
  ├─→ (Forgot to call SET!) 🔥
  ├─→ SELECT * FROM projects
  │   Query executes with tenant_id = 'tenant-a-uuid' (leaked!)
  │   → Returns Tenant A projects to Tenant B! ❌❌❌
  └─→ COMMIT

🔥 DATA LEAK: Tenant B sees Tenant A's data!
```

**B. Safe: Transaction-Scoped Variables (SET LOCAL)**
```
Connection #42 Lifecycle (Pooled):

┌─────────────────────────────────────────────────────────────────┐
│                          Connection #42                         │
│                    (Stays alive, reused by pool)                │
└─────────────────────────────────────────────────────────────────┘

Request 1 (Tenant A):
  │
  ├─→ BEGIN
  ├─→ SET LOCAL app.current_tenant_id = 'tenant-a-uuid'  (Txn scope!)
  ├─→ SELECT * FROM projects  → Returns Tenant A projects ✅
  └─→ COMMIT
       │
       ├─→ SET LOCAL auto-resets (PostgreSQL guarantees this)
       └─→ Connection returned to pool (CLEAN STATE)

Request 2 (Tenant B):
  │  (Gets Connection #42 from pool)
  │
  ├─→ BEGIN
  ├─→ SET LOCAL app.current_tenant_id = 'tenant-b-uuid'  (New scope)
  ├─→ SELECT * FROM projects
  │   Query executes with tenant_id = 'tenant-b-uuid' ✅
  │   → Returns Tenant B projects to Tenant B ✅
  └─→ COMMIT
       │
       └─→ Connection returned to pool (CLEAN STATE)

✅ NO LEAK: Each transaction starts with clean slate!
```

**C. Edge Case: Transaction Fails Before COMMIT**
```
Connection #42:

Request 1 (Tenant A):
  │
  ├─→ BEGIN
  ├─→ SET LOCAL app.current_tenant_id = 'tenant-a-uuid'
  ├─→ SELECT * FROM projects
  ├─→ INSERT INTO projects ...
  │   └─→ ❌ Constraint violation!
  └─→ ROLLBACK (automatic)
       │
       ├─→ SET LOCAL auto-resets on ROLLBACK ✅
       └─→ Connection returned to pool (CLEAN STATE)

PostgreSQL Guarantee: SET LOCAL resets on COMMIT **or** ROLLBACK.

Defense-in-Depth: Our finally block calls RESET anyway:
  try {
      await tx.execute(sql`SET LOCAL ...`);
      return await callback(tx);
  } finally {
      await tx.execute(sql`RESET app.current_tenant_id`);
      await tx.execute(sql`RESET app.is_superadmin`);
  }

This protects against:
- External pooler bugs (PgBouncer, RDS Proxy)
- PostgreSQL bugs (extremely unlikely)
- Connection state corruption
```

**Key Takeaway**: `SET LOCAL` guarantees transaction-scoped isolation. Session state cannot leak across pooled connections.

These diagrams will be included in `docs/architecture.md` as both ASCII art (for quick reference) and Mermaid diagrams (for GitHub rendering).

---

## Project Structure

```
multi-tenant-postgres-rls/
├── src/
│   ├── config/
│   │   ├── database.ts              # Connection pool + config
│   │   └── env.ts                   # Environment validation
│   ├── database/
│   │   ├── migrations/              # SQL migrations
│   │   │   ├── 000_enable_extensions.sql
│   │   │   ├── 001_create_tenants.sql
│   │   │   ├── 002_create_users.sql
│   │   │   ├── 003_create_projects.sql
│   │   │   ├── 004_create_tasks.sql
│   │   │   ├── 004b_create_admin_audit_log.sql
│   │   │   ├── 004c_create_updated_at_triggers.sql
│   │   │   ├── 004d_create_composite_fks_and_indexes.sql
│   │   │   ├── 005_enable_rls.sql    ⭐ Core RLS policies
│   │   │   └── 006_privileged_access.sql
│   │   ├── seeds/                   # Demo data
│   │   ├── schema.ts                # Kysely types
│   │   └── client.ts                # DB singleton
│   ├── middleware/
│   │   ├── tenant-context.ts        ⭐ SET tenant_id
│   │   ├── auth.ts                  # JWT auth
│   │   └── error-handler.ts
│   ├── modules/
│   │   ├── tenants/                 # Tenant CRUD
│   │   ├── projects/                # Project CRUD
│   │   └── tasks/                   # Task CRUD
│   ├── utils/
│   │   ├── tenant-context.ts        ⭐ Transaction wrappers
│   │   ├── logger.ts                # Structured logging
│   │   └── validation.ts            # Zod schemas
│   ├── app.ts                       # Express setup
│   └── server.ts                    # Entry point
├── tests/
│   ├── integration/
│   │   ├── setup.ts                 # Testcontainers
│   │   ├── tenant-isolation.test.ts ⭐ Core isolation tests
│   │   ├── projects.test.ts
│   │   ├── privileged-access.test.ts
│   │   └── performance.test.ts      # RLS benchmarks
│   └── helpers/
│       ├── test-db.ts
│       └── fixtures.ts
├── docs/
│   ├── architecture.md              # Design decisions, request lifecycle diagrams,
│   │                                # role-based privileged access, SPOF analysis,
│   │                                # connection pool safety, scoped DB factory
│   ├── rls-policies.md              # Policy documentation + LEAKPROOF requirements
│   ├── rls-safety-checklist.md      # RLS implementation checklist (staff+ artifact)
│   └── performance.md               # Benchmark results + indexing at scale + partitioning
├── scripts/
│   ├── migrate.ts                   # Run migrations
│   ├── seed.ts                      # Seed data
│   ├── benchmark.ts                 # Performance tests
│   ├── reset-db.ts                  # Dev reset
│   ├── verify-rls-config.ts         # Verify app role has no BYPASSRLS (CI check)
│   └── delete-tenant.ts             # Safe tenant deletion with confirmation
├── docker/
│   ├── Dockerfile
│   └── postgres/
│       └── init.sql
├── docker-compose.yml               # Local dev stack
├── .github/
│   └── workflows/
│       └── ci.yml                   # CI with PostgreSQL
└── README.md
```

---

## Implementation Phases

### Phase 1: Foundation Setup
- Initialize TypeScript project
- Set up Docker Compose with PostgreSQL 15+
- Install dependencies (express, kysely, pg, vitest, etc.)
- Configure environment validation
- Set up database connection pool
- Basic Express app skeleton

**Verify**: `npm run dev` connects to PostgreSQL

### Phase 2: Database Schema & Migrations
- Set up node-pg-migrate (configured for .sql migrations)
  - **Configuration Note**: Ensure node-pg-migrate runs each migration in its own transaction (default behavior). Verify in config that `single-transaction` is NOT enabled globally.
  - **CREATE INDEX Note**: For production, you'd use `CREATE INDEX CONCURRENTLY` for zero-downtime index creation, but this **cannot run inside a transaction block**. For this demo, standard transactional `CREATE INDEX` is fine (table is empty during migrations). Document `CONCURRENTLY` pattern in `docs/architecture.md` for production deployments with live traffic.
- Create migration 000: Enable pgcrypto extension
- Create migration 001: tenants table
- Create migration 001b: Enable citext extension (for case-insensitive emails)
- Create migration 002: users table with tenant_id (using CITEXT for email field)
- Create migration 003: projects table with tenant_id
- Create migration 004: tasks table with tenant_id
- Create migration 004b: admin_audit_log table (no RLS - global privileged access tracking)
- Create migration 004c: updated_at trigger function and apply to all tables with updated_at
- Create migration 004d: Composite FKs (tenant boundary enforcement) + supporting UNIQUE constraints + composite indexes
- Create migration 005: Enable + FORCE RLS on all tables. Create all policies for users/tasks. For projects: create INSERT/UPDATE/DELETE policies only (SELECT comes in 006)
- Create migration 005b: Add `COMMENT ON POLICY` for all RLS policies (professional documentation)
- Create migration 006: Create projects_select combined policy with privileged access clause
- Generate Kysely types from schema
- Create seed data script with demo tenants

**Professional Polish**:
- Add `COMMENT ON POLICY` statements documenting purpose of each policy
- Add `COMMENT ON TABLE` and `COMMENT ON COLUMN` for schema documentation
- Example: `COMMENT ON POLICY users_select ON users IS 'Tenant isolation: users can only SELECT rows matching their tenant context';`

**Migration Safety Checklist**:
- [ ] Each migration is idempotent (can be re-run safely during development)
- [ ] Migration order documented (no forward references)
- [ ] Extensions created before tables that use them
- [ ] Indexes created after tables (not inline with CREATE TABLE for clarity)
- [ ] RLS enabled after all schema changes (policies are last)
- [ ] No `single-transaction` mode (prevents CREATE INDEX CONCURRENTLY in future)

**Verify**: Run migrations, check RLS with `\d+ projects` and `SELECT * FROM pg_policies`

### Phase 3: Core RLS Infrastructure
- Implement tenant context middleware (with proper transaction lifecycle)
- Create transaction wrapper utilities
- JWT-based tenant extraction
- Privileged access flag support (off by default)
- Comprehensive logging (especially for privileged access)
- Error handling for missing context

**Verify**: Manual API testing shows tenant isolation

### Phase 4: API Implementation
- Tenant management endpoints
- Projects CRUD
- Tasks CRUD
- Users CRUD
- Request validation (Zod)
- Error handling
- **Professional Polish**: Correlation ID middleware
  - Generate unique request ID for every request (UUID v4)
  - Include in all logs: `logger.info('Query executed', { correlationId, tenantId })`
  - Return in response headers: `X-Correlation-ID`
  - Pass to audit log entries for privileged access tracing
  - Enables distributed tracing and log correlation

**Verify**: All CRUD operations work

### Phase 5: Testing Infrastructure
- Configure Vitest + TypeScript
- Set up Testcontainers
- Test database utilities
- Test fixtures and factories
- Test lifecycle management

**Verify**: `npm test` spins up PostgreSQL

### Phase 6: Core Isolation Tests
- ✅ Tenant A cannot read Tenant B data
- ✅ Tenant A cannot update Tenant B data
- ✅ Tenant A cannot delete Tenant B data
- ✅ Invalid tenant_id inserts fail
- ✅ Missing tenant context fails safely
- ✅ Transaction rollback preserves isolation
- ✅ Concurrent requests maintain isolation
- ✅ Foreign keys respect tenant boundaries
- ✅ SQL injection attempts still enforce RLS

**Verify**: All isolation tests pass

### Phase 7: Advanced Features
- Privileged access pattern implementation
- Privileged access tests (with threat model documentation)
- Performance benchmark script
- Measure RLS overhead (expect 5-10%)
- EXPLAIN ANALYZE examples
- Document performance results
- **Professional Polish**: Tenant deletion script (`scripts/delete-tenant.ts`)
  - Safe tenant deletion with confirmation prompt
  - Validates tenant exists before deletion
  - Shows row counts for all tenant-related tables
  - Uses `CASCADE` to delete all related data
  - Audit logs deletion operation
  - Example usage: `npm run delete-tenant -- --tenant-id=xxx --confirm`
  - Demonstrates understanding of data lifecycle management

**Verify**: Benchmarks complete, documented

### Phase 8: Documentation & Polish
- Comprehensive README with value proposition
- docs/architecture.md ⭐ (Critical showcase artifact)
  - Design decisions and trade-offs
  - Role-based privileged access alternative (production-grade pattern)
  - SECURITY DEFINER safety patterns
  - **Architecture Diagrams** (both ASCII and Mermaid):
    - Request Lifecycle: Happy Path vs. Attack (3 diagrams: normal, missing JWT, SQL injection)
    - Connection Pooling Risk: Session Scope (dangerous) vs. Transaction Scope (safe)
    - Privileged access flow with audit logging
    - Error path handling (rollback scenarios)
  - Connection pool safety patterns (PgBouncer, RDS Proxy, DISCARD ALL)
  - Scoped Database Factory pattern (all 3 implementation approaches)
  - **Single-Point-of-Failure Analysis** ⭐ (what happens when each security layer fails)
  - CREATE INDEX CONCURRENTLY for production (zero-downtime index creation)
- docs/rls-policies.md
  - Policy documentation with examples
  - LEAKPROOF requirements for custom functions
  - Policy composition (PERMISSIVE vs RESTRICTIVE)
  - COMMENT ON POLICY examples
- docs/rls-safety-checklist.md ⭐ (staff+ level operational checklist)
  - Complete checklist covering all aspects
  - Migration safety checklist
  - BYPASSRLS verification steps
- docs/performance.md
  - Benchmark results (with/without RLS)
  - **Indexing trade-offs at scale** (global indexes vs partitioning)
  - **Privileged query performance**: Seq Scan explanation and mitigation strategies
  - Query plan examples with EXPLAIN ANALYZE
  - Index maintenance monitoring checklist (pgstattuple, pg_repack)
  - Partition strategy for 10k+ tenants
- GitHub Actions CI setup
  - Run migrations (verify node-pg-migrate config)
  - Run all tests with Testcontainers
  - **Verify no BYPASSRLS on app role** (`scripts/verify-rls-config.ts`)
  - Coverage report (85%+ overall, 100% RLS isolation)
  - Lint checks
- Badges (CI, coverage, license)
- Demo GIF/video showing isolation (curl examples or Postman)
- LICENSE file (MIT)

**Professional Polish Checklist**:
- [ ] All diagrams render correctly on GitHub (Mermaid + ASCII fallback)
- [ ] Code examples are syntax-highlighted
- [ ] Internal links work (architecture.md ↔ performance.md ↔ checklist.md)
- [ ] Tables formatted consistently
- [ ] No broken links to external resources
- [ ] README has clear "Why This Project?" section explaining staff+ differentiators
- [ ] Each doc has table of contents for easy navigation

**Verify**: Fresh clone → working demo in < 5 min

---

## Testing Strategy

### Integration Tests (70% focus)

**Tenant Isolation Suite** (most critical):
```typescript
test('tenant A cannot read tenant B projects', async () => {
    const projectB = await tenantB.createProject({ name: 'Secret' });
    const projectsA = await tenantA.getProjects();
    expect(projectsA).not.toContainEqual(
        expect.objectContaining({ id: projectB.id })
    );
});

test('SQL injection still enforces RLS', async () => {
    const projectB = await tenantB.createProject({ name: 'Target' });
    const result = await tenantA.rawQuery(
        `SELECT * FROM projects WHERE id = '${projectB.id}'`
    );
    expect(result).toHaveLength(0);
});

test('missing tenant context fails at API layer (not DB)', async () => {
    // Request without tenant JWT/header
    const response = await request(app)
        .get('/api/projects')
        .expect(401);  // or 403 depending on implementation

    // DB layer would fail closed with zero rows, but middleware catches first
    // This prevents misleading "200 OK with empty array" responses
});
```

**Missing Tenant Context Behavior** (fail-closed at multiple layers):
- **API Layer**: Middleware validates tenant context exists and returns `401 Unauthorized` or `403 Forbidden` before executing queries
- **DB Layer**: RLS policies use `current_setting(..., true)` which returns NULL if unset. Since `NULL = anything` is false, policies return zero rows (fail-closed)
- **Why both layers**: Middleware prevents misleading "200 OK with empty array" responses. DB layer provides defense-in-depth if middleware is bypassed.
- **Testing expectation**: Missing tenant context returns `401`/`403` at API layer (never `200` with empty data)

**Privileged Access Suite**:
```typescript
test('privileged access can query cross-tenant (explicit opt-in)', async () => {
    await tenantA.createProject({ name: 'A Project' });
    await tenantB.createProject({ name: 'B Project' });

    // Explicit privileged context (off by default)
    const all = await withPrivilegedAccess(() =>
        getAllProjects() // No tenant filtering
    );

    expect(all).toHaveLength(2);
});

test('privileged access disabled by default', async () => {
    // Normal context should still enforce isolation
    const projects = await tenantA.getProjects();
    // Should only see tenant A projects
});
```

**Performance Benchmarks**:
```typescript
test('RLS overhead < 15%', async () => {
    const withRLS = await measureQueryTime(() =>
        tenantA.getProjects()
    );
    const withoutRLS = await measureQueryTime(() =>
        adminBypassRLS.getProjects()
    );
    const overhead = (withRLS - withoutRLS) / withoutRLS;
    expect(overhead).toBeLessThan(0.15);
});
```

### Coverage Goals
- Overall: 85%+
- RLS isolation: 100%
- Core services: 90%+

---

## Critical Files

Top 5 files that make RLS work:

1. **src/middleware/tenant-context.ts**
   - Sets `app.current_tenant_id` for every request
   - Core middleware enforcing tenant context

2. **src/database/migrations/005_enable_rls.sql**
   - Enables RLS on all tables
   - Creates all tenant isolation policies
   - Showcase centerpiece

3. **src/utils/tenant-context.ts**
   - Transaction wrapper utilities
   - Clean API for tenant-scoped queries

4. **tests/integration/tenant-isolation.test.ts**
   - Proves tenant isolation works
   - Key evidence of RLS enforcement

5. **src/config/database.ts**
   - Connection pooling setup
   - Optimized for RLS usage

---

## Performance Considerations

**Expected RLS Overhead**: 5-10% query time increase

**Mitigation Strategies**:
- Indexes on all `tenant_id` columns
- Connection pooling (size 10-20)
- Query plan optimization

**Benchmarks to Include**:
- Simple SELECT with/without RLS
- Complex JOIN with/without RLS
- INSERT/UPDATE/DELETE with RLS
- Concurrent multi-tenant load test

### Indexing Trade-offs at Scale

**The Global Index Challenge**:

With shared schema multi-tenancy, all indexes are **global** (span all tenants). This has implications at scale:

**Problem 1: Index Bloat**
- `CREATE INDEX idx_users_tenant_id ON users(tenant_id)` creates a **single B-tree spanning all tenants**
- At 10,000 tenants × 1,000 users/tenant = 10M rows in one index
- Index maintenance (INSERT/UPDATE/DELETE) gets slower as index grows
- VACUUM efficiency decreases

**Problem 2: Cache Contention**
- PostgreSQL buffer cache must hold index pages for ALL tenants
- Active tenants (hot data) compete with inactive tenants (cold data) for cache space
- Index scans may read many irrelevant pages before finding target tenant's data

**Trade-off: Global Uniqueness vs Locality**

**Current approach (global indexes)**:
```sql
CREATE INDEX idx_users_tenant_id ON users(tenant_id);  -- All tenants in one B-tree
```
- ✅ Simple to implement
- ✅ Supports global uniqueness constraints
- ✅ Good for < 1000 tenants
- ❌ Index maintenance overhead grows with total row count
- ❌ Cache locality issues at high scale

**Alternative: Partitioning for Locality** (production at scale)
```sql
-- Partition users table by tenant_id (declarative partitioning)
CREATE TABLE users (
    id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    email CITEXT NOT NULL,
    -- ... other columns
    PRIMARY KEY (tenant_id, id)  -- Must include partition key
) PARTITION BY HASH (tenant_id);

-- Create 64 partitions (adjust based on tenant count)
CREATE TABLE users_p0 PARTITION OF users FOR VALUES WITH (MODULUS 64, REMAINDER 0);
CREATE TABLE users_p1 PARTITION OF users FOR VALUES WITH (MODULUS 64, REMAINDER 1);
-- ... 62 more partitions

-- Now indexes are per-partition (better locality)
CREATE INDEX idx_users_p0_tenant_id ON users_p0(tenant_id);
CREATE INDEX idx_users_p1_tenant_id ON users_p1(tenant_id);
-- Repeat for all partitions
```

**Partitioning benefits**:
- ✅ Smaller per-partition indexes (better cache hit rate)
- ✅ VACUUM runs per-partition (faster, less locking)
- ✅ Can drop entire partition for tenant deletion (instant)
- ✅ Partition pruning: queries with `tenant_id` only scan relevant partition
- ❌ More complex DDL (must manage partitions)
- ❌ Cannot have global uniqueness constraints (unique only within partition)
- ❌ Partition key must be part of PRIMARY KEY

**Scale Threshold**: Consider partitioning when:
- Total table size > 100GB per table
- Tenant count > 5,000-10,000
- Query latency degrades due to index size
- VACUUM takes > 1 hour per table

**For this showcase**: We use simple global indexes (no partitioning). Document partitioning approach in `docs/performance.md` as the "next step" at scale. This demonstrates awareness of production scaling challenges without overengineering the demo.

**Visual Aid for docs/performance.md**: Include diagram comparing:
- **Global Index Architecture** (current): Single B-tree spanning all tenants
  - Simple, good for < 1000 tenants
  - Index bloat at scale
- **Partitioned Architecture** (scale strategy): 64 partitions with per-partition indexes
  - Better cache locality
  - Faster VACUUM
  - Instant tenant deletion (DROP PARTITION)

This visualization makes the trade-off immediately clear to readers scanning the repo.

**Composite Index Strategy** (current implementation):

Our composite indexes (`tenant_id, status`) provide:
1. **Efficient tenant isolation**: Index includes tenant_id as leading column
2. **Common filter patterns**: Status filtering within tenant is one index scan
3. **Covering index potential**: Can add more columns for index-only scans

Example query plan:
```sql
EXPLAIN ANALYZE SELECT * FROM projects WHERE tenant_id = '...' AND status = 'active';

-- With composite index:
Index Scan using idx_projects_tenant_status on projects
  Index Cond: ((tenant_id = '...'::uuid) AND (status = 'active'::text))
  -- Fast: single B-tree descent to find both conditions
```

**Index Maintenance Monitoring** (production checklist):
- Track index bloat with `pgstattuple` extension
- Monitor `pg_stat_user_indexes` for index usage
- Schedule REINDEX during maintenance windows if bloat > 30%
- Consider `pg_repack` for online index rebuilds (zero downtime)

---

## Key Features to Highlight

### Core Features
1. ✅ **Database-level enforcement** - Security at DB layer, not app
2. ✅ **Session variable pattern** - Industry-standard `SET LOCAL` (transaction-scoped)
3. ✅ **Type-safe queries** - Kysely provides compile-time safety
4. ✅ **Comprehensive testing** - Real PostgreSQL with Testcontainers
5. ✅ **Privileged access pattern** - Advanced RLS for platform administration (explicit opt-in, threat model documented)
6. ✅ **Performance benchmarks** - Measured overhead with mitigation
7. ✅ **Production-ready** - Migrations, Docker, CI/CD, error handling

### Staff+ Level Differentiators
8. ✅ **Defense-in-depth architecture** - Multiple overlapping security layers with documented failure modes
9. ✅ **Composite foreign keys** - Tenant boundary enforcement at constraint level (rare in portfolios)
10. ✅ **Connection pool safety** - Explicit RESET, pooler compatibility (PgBouncer, RDS Proxy)
11. ✅ **Scoped Database Factory** - Prevents "naked query" trap (compile-time + runtime enforcement)
12. ✅ **Single-Point-of-Failure Analysis** - Documents what happens when each security layer fails
13. ✅ **Role-based privileged access** - Production-grade alternative with connection-level privilege separation
14. ✅ **LEAKPROOF awareness** - Documented side-channel attack prevention for custom functions
15. ✅ **Scale considerations** - Indexing trade-offs, partitioning strategy for 10k+ tenants
16. ✅ **Professional polish** - CITEXT emails, correlation IDs, policy comments, BYPASSRLS verification
17. ✅ **Request lifecycle visualization** - Sequence diagrams showing transaction flow
18. ✅ **Operational maturity** - Tenant deletion script, RLS safety checklist, monitoring guidance

**What sets this apart**: Most RLS demos stop at "SET tenant_id + basic policies." This implementation demonstrates **production-grade thinking**: failure mode analysis, scale considerations, defense-in-depth, and operational maturity.

---

## RLS Safety Checklist

This checklist will be implemented in `docs/rls-safety-checklist.md` - a staff+ level artifact demonstrating systematic thinking about RLS correctness.

### Schema Design
- [ ] Every tenant-aware table has `tenant_id UUID NOT NULL`
- [ ] Every tenant-aware table has index on `tenant_id`
- [ ] All tenant_id columns use consistent type (UUID)
- [ ] Foreign keys respect tenant boundaries (composite FK where needed)
- [ ] No cross-tenant joins without explicit tenant predicate

### RLS Policies
- [ ] RLS enabled on all tenant-aware tables (`ENABLE ROW LEVEL SECURITY`)
- [ ] RLS forced even for table owners (`FORCE ROW LEVEL SECURITY`)
- [ ] Policies use `current_setting(..., true)` (missing-safe)
- [ ] Policies cover all operations: SELECT, INSERT, UPDATE, DELETE
- [ ] Policies tested for NULL tenant context (should return zero rows)
- [ ] INSERT policies use `WITH CHECK` clause
- [ ] UPDATE policies have both `USING` and `WITH CHECK`
- [ ] Custom functions in policies are marked `LEAKPROOF` (prevents side-channel attacks via error messages)

### Session Management
- [ ] Use `SET LOCAL` not `SET` (transaction-scoped)
- [ ] Tenant context set with `SET LOCAL` inside each transaction scope (per-handler wrapper preferred over request-scoped)
- [ ] Tenant context validated at middleware layer (fail early)
- [ ] Missing tenant context handled gracefully (401/403 at API layer, zero rows at DB layer)
- [ ] Transaction cleanup guaranteed (automatic with per-handler wrappers)

### Privileged Access
- [ ] Privileged access disabled by default
- [ ] Privileged access requires explicit opt-in
- [ ] Privileged access never derived from user claims alone
- [ ] All privileged queries logged/audited
- [ ] Privileged access documented with threat model
- [ ] Consider role-based approach (not just session variables)

### Testing
- [ ] Cross-tenant read attempts blocked (tenant A cannot read tenant B)
- [ ] Cross-tenant write attempts blocked (tenant A cannot update tenant B)
- [ ] Cross-tenant delete attempts blocked (tenant A cannot delete tenant B)
- [ ] INSERT with wrong tenant_id fails
- [ ] Missing tenant context fails safely (zero rows)
- [ ] SQL injection with tenant bypass blocked
- [ ] Foreign key constraints respect tenant boundaries
- [ ] Transaction rollback preserves isolation
- [ ] Concurrent requests maintain isolation

### Security
- [ ] No `SECURITY DEFINER` functions without strict controls
- [ ] No `BYPASSRLS` role attribute except explicit admin role
- [ ] Connection strings use least-privilege credentials
- [ ] Audit logging for all privileged operations
- [ ] Schema migrations reviewed for RLS gaps

### Performance
- [ ] Indexes on all `tenant_id` columns
- [ ] Query plans verified with `EXPLAIN ANALYZE`
- [ ] RLS overhead measured and acceptable (< 15%)
- [ ] Connection pooling configured appropriately
- [ ] Long-running transactions identified and mitigated

### Operational
- [ ] Migration strategy for adding new tenant-aware tables
- [ ] Documentation for RLS policy patterns
- [ ] Runbook for investigating tenant isolation issues
- [ ] Monitoring for missing tenant context errors
- [ ] Backup/restore tested for tenant data

---

## Quick Start (Target: < 5 minutes)

```bash
# Clone and setup
git clone https://github.com/[user]/multi-tenant-postgres-rls.git
cd multi-tenant-postgres-rls
cp .env.example .env

# Start database
docker-compose up -d

# Install and migrate
npm install
npm run migrate
npm run seed

# Start server
npm run dev
```

Server runs on http://localhost:3000

### Test Tenant Isolation

```bash
# Create project as Tenant A
curl -X POST http://localhost:3000/api/projects \
  -H "Authorization: Bearer [tenant-a-token]" \
  -H "Content-Type: application/json" \
  -d '{"name": "A Project"}'

# Try to read as Tenant B (should return empty)
curl http://localhost:3000/api/projects \
  -H "Authorization: Bearer [tenant-b-token]"
```

### Run Tests

```bash
npm test              # All tests
npm run test:coverage # Coverage report
npm run benchmark     # Performance tests
```

---

## Success Criteria

Project successfully showcases RLS when:

- ✅ Fresh clone to working demo < 5 minutes
- ✅ All isolation tests pass (100% for RLS)
- ✅ RLS policies visible in SQL migrations
- ✅ Privileged access pattern demonstrates advanced RLS with documented threat model
- ✅ Performance overhead documented (< 15%)
- ✅ README clearly explains value proposition
- ✅ CI/CD validates tests automatically
- ✅ Production-grade code quality

---

## Naming Consideration

Current repo: `multi-tenant-postgres-rls`

Alternative (optional): `postgres-rls-multi-tenant-reference`

The "reference" suffix signals "this is how it should be done" - gives it reference implementation vibes. However, the current name is clean and descriptive. This is optional polish and not critical to the showcase value.

---

## Plan Maturity: From "Competent" to "Principal-Level"

This plan has evolved through multiple refinement cycles, incorporating increasingly sophisticated architectural patterns and operational considerations.

### Evolution Summary

**Initial Plan** (Competent Senior):
- Basic RLS policies with `SET LOCAL`
- Simple transaction wrappers
- Standard testing approach
- Documented happy path

**First Refinements** (Strong Senior):
- Composite foreign keys (tenant boundary enforcement)
- Privileged access pattern with threat model
- Performance benchmarks
- Fail-closed behavior documented

**Second Refinements** (Staff Level):
- Defense-in-depth architecture
- Connection pool safety (pooler compatibility)
- Scoped Database Factory (preventing naked queries)
- Single-Point-of-Failure Analysis
- Scale considerations (indexing, partitioning)
- Role-based privileged access (connection-level isolation)

**Final Refinements** (Staff/Principal):
- **Architecture Visualization**: Request lifecycle diagrams (happy path + 3 attack scenarios)
- **Connection Pooling Risk Diagram**: Visual comparison of session vs transaction scope
- **Privileged Query Performance**: Explicit documentation of Seq Scan trade-off
- **Superadmin Reset Risk**: RESET both `app.current_tenant_id` AND `app.is_superadmin`
- **Migration Configuration**: Verified node-pg-migrate transaction handling
- **Scoped Database Factory**: Complete implementation with branded types
- **CREATE INDEX CONCURRENTLY**: Production pattern for zero-downtime DDL

### What Makes This "Bulletproof"

1. **Visual Architecture Documentation**: Diagrams show exactly where each security layer lives and how it fails gracefully
2. **Complete Implementation Patterns**: Every abstraction has concrete code (not just pseudocode)
3. **Performance Trade-offs Acknowledged**: Documents Seq Scan for privileged queries (acceptable for low-volume admin traffic)
4. **Connection Pool Edge Cases**: Explicit RESET in finally block protects against pooler bugs
5. **Compile-Time + Runtime Safety**: Branded types prevent "naked query" trap at type-check time
6. **Operational Maturity**: Migration safety, tenant deletion, BYPASSRLS verification in CI

### Signals to Reviewers

**Competent engineer**: Implements working RLS policies
**Senior engineer**: Adds composite FKs, testing, documentation
**Staff engineer**: Analyzes failure modes, documents scale considerations, implements defense-in-depth
**Principal engineer**: Visualizes architecture, documents trade-offs explicitly, provides production migration path

This plan is now at **Staff/Principal** level. It demonstrates:
- ✅ Production experience (knows the edge cases)
- ✅ Architectural thinking (defense-in-depth, not just features)
- ✅ Operational maturity (monitoring, maintenance, safety checks)
- ✅ Communication skill (visual diagrams, clear trade-off documentation)
- ✅ Scale awareness (partitioning, index bloat, performance optimization)

---

## Next Steps

1. ~~Review and approve this plan~~ ✅ Plan is finalized and bulletproof
2. Initialize TypeScript project structure
3. Set up Docker Compose
4. Begin Phase 1 implementation (Foundation setup + Scoped Database Factory)
5. Commit frequently with clear messages
6. Open PR when ready for review

---

## References

- [PostgreSQL RLS Documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Multi-Tenancy Patterns](https://docs.microsoft.com/en-us/azure/architecture/patterns/category/multi-tenancy)
- [Kysely Documentation](https://kysely.dev/)
- [Testcontainers Node](https://node.testcontainers.org/)
