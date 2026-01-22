import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import { startTestDatabase, stopTestDatabase, cleanTestData } from './db-container.js';
import { createTestTenant, createTestUser, createTestProject } from './fixtures.js';

/**
 * Smoke tests for testing infrastructure
 *
 * Verifies that:
 * - Testcontainers can start PostgreSQL
 * - Migrations run successfully
 * - Basic CRUD operations work
 * - Test fixtures create data correctly
 */

describe('Testing Infrastructure', () => {
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

  it('should start PostgreSQL container and run migrations', async () => {
    // Verify database is accessible
    const result = await db.selectFrom('tenants').selectAll().execute();
    expect(result).toEqual([]);
  });

  it('should create a tenant using fixture', async () => {
    const tenant = await createTestTenant(db, { name: 'Test Corp' });

    expect(tenant.id).toBeDefined();
    expect(tenant.name).toBe('Test Corp');
    expect(tenant.slug).toMatch(/^test-/);
    expect(tenant.created_at).toBeInstanceOf(Date);
  });

  it('should create a user using fixture', async () => {
    const tenant = await createTestTenant(db);
    const user = await createTestUser(db, tenant.id, {
      name: 'John Doe',
      email: 'john@example.com',
      role: 'admin',
    });

    expect(user.id).toBeDefined();
    expect(user.tenant_id).toBe(tenant.id);
    expect(user.name).toBe('John Doe');
    expect(user.email).toBe('john@example.com');
    expect(user.role).toBe('admin');
  });

  it('should create a project using fixture', async () => {
    const tenant = await createTestTenant(db);
    const project = await createTestProject(db, tenant.id, {
      name: 'My Project',
      description: 'A test project',
      status: 'active',
    });

    expect(project.id).toBeDefined();
    expect(project.tenant_id).toBe(tenant.id);
    expect(project.name).toBe('My Project');
    expect(project.description).toBe('A test project');
    expect(project.status).toBe('active');
  });

  it('should clean test data between tests', async () => {
    await createTestTenant(db, { name: 'First Tenant' });

    const beforeClean = await db.selectFrom('tenants').selectAll().execute();
    expect(beforeClean.length).toBe(1);

    await cleanTestData(db);

    const afterClean = await db.selectFrom('tenants').selectAll().execute();
    expect(afterClean.length).toBe(0);
  });
});
