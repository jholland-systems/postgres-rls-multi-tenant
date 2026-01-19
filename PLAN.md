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
| **Framework** | Express | Lightweight, familiar, easy to understand |
| **Database** | PostgreSQL 15+ | Mature RLS features, excellent documentation |
| **Query Builder** | Kysely | Type-safe SQL that keeps policies visible (doesn't hide RLS) |
| **Migrations** | node-pg-migrate | Pure SQL migrations for clarity |
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

```sql
-- Tenants (no RLS)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users (with RLS)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

-- Projects (with RLS)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks (with RLS)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    assigned_to UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Critical indexes for performance
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX idx_tasks_tenant_id ON tasks(tenant_id);
```

### RLS Policies

```sql
-- Enable RLS on multi-tenant tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Example: Projects table policies
CREATE POLICY tenant_isolation_select ON projects
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation_insert ON projects
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation_update ON projects
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation_delete ON projects
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Repeat for users and tasks tables
```

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

```sql
-- Privileged access policy for cross-tenant queries
CREATE POLICY privileged_access_select ON projects
    FOR SELECT
    USING (
        tenant_id = current_setting('app.current_tenant_id')::UUID
        OR current_setting('app.is_superadmin', true)::boolean = true
    );
```

**Documentation requirement**: Every privileged access code path must document:
1. Why it needs cross-tenant access
2. What happens if it's compromised
3. How it's audited

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

### Tenant Context Middleware

**Important**: All request handlers must execute within an explicit transaction to ensure `SET LOCAL` remains active.

```typescript
// Request-scoped transaction lifecycle
app.use(async (req, res, next) => {
    const tenantId = extractTenantFromJWT(req);
    const isSuperadmin = checkSuperadminRole(req);

    // Begin transaction - remains open for entire request lifecycle
    const tx = await db.beginTransaction();

    // Set session variables (scoped to this transaction only)
    await tx.execute(
        sql`SET LOCAL app.current_tenant_id = ${tenantId}`
    );

    // Privileged access opt-in (off by default)
    if (isSuperadmin) {
        await tx.execute(
            sql`SET LOCAL app.is_superadmin = true`
        );
    }

    // Store transaction in request context
    req.db = tx;

    // Commit/rollback on response completion
    res.on('finish', async () => {
        await tx.commit();
    });

    res.on('close', async () => {
        await tx.rollback();
    });

    next();
});
```

**Note**: Actual implementation may use middleware framework abstractions, but the transaction lifetime must span the entire request.

### Transaction Wrapper Pattern

```typescript
// Utility for tenant-scoped queries
async function withTenantContext<T>(
    tenantId: string,
    callback: (tx: Transaction) => Promise<T>
): Promise<T> {
    return await db.transaction(async (tx) => {
        await tx.executeQuery(
            sql`SET LOCAL app.current_tenant_id = ${tenantId}`
        );
        return await callback(tx);
    });
}
```

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
│   │   │   ├── 001_create_tenants.sql
│   │   │   ├── 002_create_users.sql
│   │   │   ├── 003_create_projects.sql
│   │   │   ├── 004_create_tasks.sql
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
│   ├── architecture.md              # Design decisions
│   ├── rls-policies.md              # Policy docs
│   └── performance.md               # Benchmark results
├── scripts/
│   ├── migrate.ts                   # Run migrations
│   ├── seed.ts                      # Seed data
│   ├── benchmark.ts                 # Performance tests
│   └── reset-db.ts                  # Dev reset
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
- Set up node-pg-migrate
- Create migrations for all tables
- Enable RLS and create policies (migration 005)
- Add privileged access pattern (migration 006)
- Generate Kysely types
- Create seed data script

**Verify**: Run migrations, check RLS policies in psql

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

**Verify**: Benchmarks complete, documented

### Phase 8: Documentation & Polish
- Comprehensive README
- Architecture documentation
- RLS policy documentation
- Performance documentation
- GitHub Actions CI setup
- Badges (CI, coverage)
- Demo GIF/video
- LICENSE file

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
```

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

---

## Key Features to Highlight

1. ✅ **Database-level enforcement** - Security at DB layer, not app
2. ✅ **Session variable pattern** - Industry-standard `SET LOCAL` (transaction-scoped)
3. ✅ **Type-safe queries** - Kysely provides compile-time safety
4. ✅ **Comprehensive testing** - Real PostgreSQL with Testcontainers
5. ✅ **Privileged access pattern** - Advanced RLS for platform administration (explicit opt-in, threat model documented)
6. ✅ **Performance benchmarks** - Measured overhead with mitigation
7. ✅ **Production-ready** - Migrations, Docker, CI/CD, error handling

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

## Next Steps

1. Review and approve this plan
2. Initialize TypeScript project structure
3. Set up Docker Compose
4. Begin Phase 1 implementation
5. Commit frequently with clear messages
6. Open PR when ready for review

---

## References

- [PostgreSQL RLS Documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Multi-Tenancy Patterns](https://docs.microsoft.com/en-us/azure/architecture/patterns/category/multi-tenancy)
- [Kysely Documentation](https://kysely.dev/)
- [Testcontainers Node](https://node.testcontainers.org/)
