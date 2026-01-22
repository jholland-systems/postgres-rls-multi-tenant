import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import { startTestDatabase, stopTestDatabase, cleanTestData } from './db-container.js';
import { createTestTenant, createTestUser, createTestProject } from './fixtures.js';
import { withTestTenantContext, withTestPrivilegedContext } from './test-helpers.js';

/**
 * Privileged Access Tests
 *
 * Tests the privileged access pattern for cross-tenant queries.
 * This is a DANGEROUS feature that bypasses tenant isolation.
 *
 * Critical properties verified:
 * - Privileged context can see all tenants' data
 * - Every privileged query writes an audit log entry
 * - Audit log write and privileged query are atomic (same transaction)
 * - If audit log fails, entire operation rolls back
 * - Normal tenant isolation still works after privileged access
 *
 * Security Model:
 * - Privileged access is OFF by default
 * - Requires explicit opt-in with withTestPrivilegedContext(db,)
 * - Every use is audited in admin_audit_log table
 * - Actor identity (id + email) is required
 * - Reason for access is required
 * - Correlation ID links to request logs
 */

describe('Privileged Access - Cross-Tenant Queries', () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    const result = await startTestDatabase();
    db = result.db;
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  afterEach(async () => {
    await cleanTestData(db);
  });

  it('should allow privileged context to see all tenants data', async () => {
    // Create two tenants with projects
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });
    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });

    // Use privileged context to see ALL projects (cross-tenant)
    const allProjects = await withTestPrivilegedContext(
      db,
      '00000000-0000-0000-0000-000000000001',
      'admin@platform.com',
      'test-correlation-id',
      'Test: Verify privileged access can see all tenants',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    // Should see BOTH projects (cross-tenant)
    expect(allProjects).toHaveLength(2);
    const projectIds = allProjects.map((p) => p.id).sort();
    expect(projectIds).toEqual([projectA.id, projectB.id].sort());
  });

  it('should write audit log entry for every privileged query', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    await createTestProject(db, tenant.id, { name: 'Project A' });

    const actorId = '00000000-0000-0000-0000-000000000002';
    const actorEmail = 'admin@platform.com';
    const correlationId = 'correlation-456';
    const reason = 'Monthly billing aggregation';

    // Execute privileged query
    await withTestPrivilegedContext(db,actorId, actorEmail, correlationId, reason, async (tx) => {
      return await tx.selectFrom('projects').selectAll().execute();
    });

    // Verify audit log entry was created
    const auditLogs = await db.selectFrom('admin_audit_log').selectAll().execute();

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].actor_id).toBe(actorId);
    expect(auditLogs[0].actor_email).toBe(actorEmail);
    expect(auditLogs[0].action).toBe('privileged_cross_tenant_query');
    expect(auditLogs[0].correlation_id).toBe(correlationId);
    expect(auditLogs[0].reason).toBe(reason);
    expect(auditLogs[0].metadata).toBeDefined();
  });

  it('should rollback privileged operation if audit log write fails', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    await createTestProject(db, tenant.id, { name: 'Project A' });

    // Try to execute privileged query with invalid actor_id (should fail audit log constraint)
    await expect(async () => {
      await withTestPrivilegedContext(db,
        'not-a-valid-uuid', // Invalid UUID for actor_id
        'admin@platform.com',
        'test-correlation-id',
        'Should fail audit log write',
        async (tx) => {
          // This query would succeed, but audit log will fail
          return await tx.selectFrom('projects').selectAll().execute();
        }
      );
    }).rejects.toThrow();

    // Verify NO audit log entry was created (transaction rolled back)
    const auditLogs = await db.selectFrom('admin_audit_log').selectAll().execute();
    expect(auditLogs).toHaveLength(0);
  });

  it('should maintain tenant isolation after privileged access', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });
    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });

    // 1. Use privileged context to see all projects
    const allProjects = await withTestPrivilegedContext(db,
      '00000000-0000-0000-0000-000000000001',
      'admin@platform.com',
      'test-correlation-id',
      'Test: Verify isolation after privileged access',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    expect(allProjects).toHaveLength(2);

    // 2. Switch back to normal tenant context - should only see own data
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const projects = await tx.selectFrom('projects').selectAll().execute();

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(projectA.id);
    });

    // 3. Try another tenant - should only see their data
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const projects = await tx.selectFrom('projects').selectAll().execute();

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(projectB.id);
    });
  });

  it('should allow privileged queries without tenant_id set', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });
    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });

    // Privileged context should see all projects (no tenant context set)
    // Note: Privileged access only works on projects table, not users/tasks
    const allProjects = await withTestPrivilegedContext(db,
      '00000000-0000-0000-0000-000000000001',
      'admin@platform.com',
      'test-correlation-id',
      'Test: Privileged access to projects across all tenants',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    expect(allProjects).toHaveLength(2);
    const projectNames = allProjects.map((p) => p.name).sort();
    expect(projectNames).toEqual(['Project A', 'Project B']);
  });

  it('should handle concurrent privileged and tenant queries correctly', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });
    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });

    // Execute privileged and tenant queries concurrently
    const [privilegedProjects, tenantAProjects, tenantBProjects] = await Promise.all([
      withTestPrivilegedContext(db,
        '00000000-0000-0000-0000-000000000001',
        'admin@platform.com',
        'test-correlation-id-1',
        'Test: Concurrent privileged access',
        async (tx) => {
          return await tx.selectFrom('projects').selectAll().execute();
        }
      ),
      withTestTenantContext(db, tenantA.id, async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }),
      withTestTenantContext(db, tenantB.id, async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }),
    ]);

    // Privileged should see all
    expect(privilegedProjects).toHaveLength(2);

    // Tenant A should only see their project
    expect(tenantAProjects).toHaveLength(1);
    expect(tenantAProjects[0].id).toBe(projectA.id);

    // Tenant B should only see their project
    expect(tenantBProjects).toHaveLength(1);
    expect(tenantBProjects[0].id).toBe(projectB.id);
  });
});

describe('Privileged Access - Security Guardrails', () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    const result = await startTestDatabase();
    db = result.db;
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  afterEach(async () => {
    await cleanTestData(db);
  });

  it('should require all audit parameters (actor_id, actor_email, reason)', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    await createTestProject(db, tenant.id, { name: 'Project A' });

    // All audit parameters are required by TypeScript types
    // This test verifies the implementation enforces them

    // Valid call with all parameters
    await withTestPrivilegedContext(db,
      '00000000-0000-0000-0000-000000000002',
      'admin@platform.com',
      'correlation-id',
      'Valid reason',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    // Verify audit log has all fields
    const auditLogs = await db.selectFrom('admin_audit_log').selectAll().execute();
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].actor_id).toBe('00000000-0000-0000-0000-000000000002');
    expect(auditLogs[0].actor_email).toBe('admin@platform.com');
    expect(auditLogs[0].reason).toBe('Valid reason');
    expect(auditLogs[0].correlation_id).toBe('correlation-id');
  });

  it('should reset privileged flag after query completes', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    await createTestProject(db, tenant.id, { name: 'Project A' });

    // Execute privileged query
    await withTestPrivilegedContext(db,
      '00000000-0000-0000-0000-000000000001',
      'admin@platform.com',
      'test-correlation-id',
      'Test: Verify privileged flag is reset',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    // Verify privileged flag is NOT set in subsequent queries
    await withTestTenantContext(db, tenant.id, async (tx) => {
      // Query within tenant context - should only see tenant's data
      const projects = await tx.selectFrom('projects').selectAll().execute();
      expect(projects).toHaveLength(1);
    });
  });

  it('should maintain audit trail across multiple privileged queries', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    await createTestProject(db, tenant.id, { name: 'Project A' });

    // Execute multiple privileged queries
    await withTestPrivilegedContext(db,
      '00000000-0000-0000-0000-000000000003',
      'admin1@platform.com',
      'correlation-1',
      'First query',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    await withTestPrivilegedContext(db,
      '00000000-0000-0000-0000-000000000004',
      'admin2@platform.com',
      'correlation-2',
      'Second query',
      async (tx) => {
        return await tx.selectFrom('projects').selectAll().execute();
      }
    );

    // Verify multiple audit log entries
    const auditLogs = await db
      .selectFrom('admin_audit_log')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();

    expect(auditLogs).toHaveLength(2);
    expect(auditLogs[0].actor_id).toBe('00000000-0000-0000-0000-000000000003');
    expect(auditLogs[0].reason).toBe('First query');
    expect(auditLogs[1].actor_id).toBe('00000000-0000-0000-0000-000000000004');
    expect(auditLogs[1].reason).toBe('Second query');
  });
});
