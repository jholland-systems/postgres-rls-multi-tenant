import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, sql } from 'kysely';
import type { Database } from '../database/schema.js';
import { startTestDatabase, stopTestDatabase, cleanTestData } from './db-container.js';
import { createTestTenant, createTestUser, createTestProject, createTestTask } from './fixtures.js';
import { withTestTenantContext } from './test-helpers.js';

/**
 * Core RLS Isolation Tests
 *
 * These tests prove that Row Level Security policies correctly isolate tenant data.
 * This is the heart of the multi-tenant architecture showcase.
 *
 * Critical properties verified:
 * - Tenant A cannot read Tenant B's data
 * - Tenant A cannot update Tenant B's data
 * - Tenant A cannot delete Tenant B's data
 * - Invalid tenant_id inserts fail
 * - Missing tenant context returns zero rows (fail-closed)
 * - Transaction rollback preserves isolation
 * - Composite FKs enforce tenant boundaries
 */

describe('RLS Isolation - Read Operations', () => {
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

  it('should isolate user reads between tenants', async () => {
    // Create two tenants with users
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const userA = await createTestUser(db, tenantA.id, { name: 'Alice', email: 'alice@a.com' });
    const userB = await createTestUser(db, tenantB.id, { name: 'Bob', email: 'bob@b.com' });

    // Tenant A can only see their user
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const users = await tx.selectFrom('users').selectAll().execute();

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(userA.id);
      expect(users[0].name).toBe('Alice');
    });

    // Tenant B can only see their user
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const users = await tx.selectFrom('users').selectAll().execute();

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(userB.id);
      expect(users[0].name).toBe('Bob');
    });
  });

  it('should isolate project reads between tenants', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });
    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });

    // Tenant A can only see their project
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const projects = await tx.selectFrom('projects').selectAll().execute();

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(projectA.id);
    });

    // Tenant B can only see their project
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const projects = await tx.selectFrom('projects').selectAll().execute();

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(projectB.id);
    });
  });

  it('should isolate task reads between tenants', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });
    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });

    const taskA = await createTestTask(db, tenantA.id, projectA.id, { title: 'Task A' });
    const taskB = await createTestTask(db, tenantB.id, projectB.id, { title: 'Task B' });

    // Tenant A can only see their task
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const tasks = await tx.selectFrom('tasks').selectAll().execute();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskA.id);
    });

    // Tenant B can only see their task
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const tasks = await tx.selectFrom('tasks').selectAll().execute();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskB.id);
    });
  });

  it('should return zero rows when tenant context is missing (fail-closed)', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    await createTestUser(db, tenant.id, { name: 'Alice' });
    await createTestProject(db, tenant.id, { name: 'Project A' });

    // Query without setting tenant context - should return zero rows
    // Explicitly RESET any variables to ensure clean state
    await db.transaction().execute(async (tx) => {
      await sql.raw('RESET app.current_tenant_id').execute(tx);
      await sql.raw('RESET app.is_superadmin').execute(tx);

      // No SET LOCAL app.current_tenant_id - should return zero rows (fail-closed)
      const users = await tx.selectFrom('users').selectAll().execute();
      const projects = await tx.selectFrom('projects').selectAll().execute();

      expect(users).toHaveLength(0);
      expect(projects).toHaveLength(0);
    });
  });

  it('should not allow reading data by direct ID if wrong tenant context', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Secret Project A' });

    // Tenant B tries to read Tenant A's project by ID
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', projectA.id)
        .executeTakeFirst();

      // RLS should prevent access even with exact ID
      expect(project).toBeUndefined();
    });
  });
});

describe('RLS Isolation - Write Operations', () => {
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

  it('should prevent updating data from other tenants', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });

    // Tenant B tries to update Tenant A's project
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const updated = await tx
        .updateTable('projects')
        .set({ name: 'Hacked Project' })
        .where('id', '=', projectA.id)
        .returningAll()
        .executeTakeFirst();

      // RLS should prevent update
      expect(updated).toBeUndefined();
    });

    // Verify project was not modified
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', projectA.id)
        .executeTakeFirstOrThrow();

      expect(project.name).toBe('Project A');
    });
  });

  it('should prevent inserting data with wrong tenant_id', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    // Set context to Tenant A but try to insert with Tenant B's ID
    await expect(async () => {
      await withTestTenantContext(db, tenantA.id, async (tx) => {
        await tx
          .insertInto('projects')
          .values({
            tenant_id: tenantB.id, // Wrong tenant!
            name: 'Malicious Project',
            status: 'active',
          })
          .execute();
      });
    }).rejects.toThrow();
  });

  it('should allow inserting data with correct tenant_id', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });

    // Set context and insert with matching tenant_id
    await withTestTenantContext(db, tenant.id, async (tx) => {
      const project = await tx
        .insertInto('projects')
        .values({
          tenant_id: tenant.id,
          name: 'Valid Project',
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(project.name).toBe('Valid Project');
    });
  });
});

describe('RLS Isolation - Delete Operations', () => {
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

  it('should prevent deleting data from other tenants', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });

    // Tenant B tries to delete Tenant A's project
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const deleted = await tx
        .deleteFrom('projects')
        .where('id', '=', projectA.id)
        .returningAll()
        .executeTakeFirst();

      // RLS should prevent deletion
      expect(deleted).toBeUndefined();
    });

    // Verify project still exists
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', projectA.id)
        .executeTakeFirst();

      expect(project).toBeDefined();
      expect(project!.name).toBe('Project A');
    });
  });

  it('should allow deleting own tenant data', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    const project = await createTestProject(db, tenant.id, { name: 'Project A' });

    // Tenant deletes their own project
    await withTestTenantContext(db, tenant.id, async (tx) => {
      const deleted = await tx
        .deleteFrom('projects')
        .where('id', '=', project.id)
        .returningAll()
        .executeTakeFirst();

      expect(deleted).toBeDefined();
      expect(deleted!.id).toBe(project.id);
    });

    // Verify project is gone
    await withTestTenantContext(db, tenant.id, async (tx) => {
      const projects = await tx.selectFrom('projects').selectAll().execute();
      expect(projects).toHaveLength(0);
    });
  });
});

describe('RLS Isolation - Transaction Rollback', () => {
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

  it('should preserve isolation after transaction rollback', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });

    // Attempt to modify in a transaction that rolls back
    try {
      await withTestTenantContext(db, tenantA.id, async (tx) => {
        await tx
          .updateTable('projects')
          .set({ name: 'Updated Project' })
          .where('id', '=', projectA.id)
          .execute();

        // Force rollback
        throw new Error('Intentional rollback');
      });
    } catch (err) {
      // Expected
    }

    // Verify data unchanged and isolation still works
    await withTestTenantContext(db, tenantA.id, async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', projectA.id)
        .executeTakeFirstOrThrow();

      expect(project.name).toBe('Project A');
    });

    // Verify Tenant B still cannot access
    await withTestTenantContext(db, tenantB.id, async (tx) => {
      const projects = await tx.selectFrom('projects').selectAll().execute();
      expect(projects).toHaveLength(0);
    });
  });
});

describe('RLS Isolation - Composite Foreign Key Boundaries', () => {
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

  it('should prevent creating task with project from different tenant', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectA = await createTestProject(db, tenantA.id, { name: 'Project A' });

    // Try to create task in Tenant B pointing to Tenant A's project
    await expect(async () => {
      await db
        .insertInto('tasks')
        .values({
          tenant_id: tenantB.id,
          project_id: projectA.id, // Cross-tenant reference!
          title: 'Malicious Task',
          status: 'pending',
        })
        .execute();
    }).rejects.toThrow(); // Composite FK constraint violation
  });

  it('should prevent creating task with assigned_to from different tenant', async () => {
    const tenantA = await createTestTenant(db, { name: 'Tenant A' });
    const tenantB = await createTestTenant(db, { name: 'Tenant B' });

    const projectB = await createTestProject(db, tenantB.id, { name: 'Project B' });
    const userA = await createTestUser(db, tenantA.id, { name: 'Alice' });

    // Try to assign task in Tenant B to user in Tenant A
    await expect(async () => {
      await db
        .insertInto('tasks')
        .values({
          tenant_id: tenantB.id,
          project_id: projectB.id,
          title: 'Task B',
          status: 'pending',
          assigned_to: userA.id, // Cross-tenant reference!
        })
        .execute();
    }).rejects.toThrow(); // Composite FK constraint violation
  });

  it('should allow creating task with same-tenant references', async () => {
    const tenant = await createTestTenant(db, { name: 'Tenant A' });
    const project = await createTestProject(db, tenant.id, { name: 'Project A' });
    const user = await createTestUser(db, tenant.id, { name: 'Alice' });

    // Create task with same-tenant references - should succeed
    const task = await withTestTenantContext(db, tenant.id, async (tx) => {
      return await tx
        .insertInto('tasks')
        .values({
          tenant_id: tenant.id,
          project_id: project.id,
          title: 'Valid Task',
          status: 'pending',
          assigned_to: user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    expect(task.title).toBe('Valid Task');
    expect(task.project_id).toBe(project.id);
    expect(task.assigned_to).toBe(user.id);
  });
});
