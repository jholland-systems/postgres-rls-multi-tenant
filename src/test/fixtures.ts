import { Kysely } from 'kysely';
import type {
  Database,
  Tenants,
  Users,
  Projects,
  Tasks,
  TenantRow,
  UserRow,
  ProjectRow,
  TaskRow,
} from '../database/schema.js';
import { withTestTenantContext } from './test-helpers.js';

/**
 * Test fixtures and factories
 *
 * Helper functions to create test data with sensible defaults.
 * Makes it easy to set up test scenarios without repeating boilerplate.
 *
 * Note: Functions that create RLS-protected data (users, projects, tasks)
 * automatically set tenant context before inserting.
 */

/**
 * Create a test tenant with optional overrides
 */
export async function createTestTenant(
  db: Kysely<Database>,
  overrides?: Partial<Omit<Tenants, 'id' | 'created_at' | 'updated_at'>>
): Promise<TenantRow> {
  const slug = overrides?.slug || `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return await db
    .insertInto('tenants')
    .values({
      name: overrides?.name || 'Test Tenant',
      slug,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Create a test user with optional overrides
 *
 * Sets tenant context before inserting to satisfy RLS policies.
 */
export async function createTestUser(
  db: Kysely<Database>,
  tenantId: string,
  overrides?: Partial<Omit<Users, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>
): Promise<UserRow> {
  const email =
    overrides?.email ||
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

  return await withTestTenantContext(db, tenantId, async (tx) => {
    return await tx
      .insertInto('users')
      .values({
        tenant_id: tenantId,
        email,
        name: overrides?.name || 'Test User',
        role: overrides?.role || 'member',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * Create a test project with optional overrides
 *
 * Sets tenant context before inserting to satisfy RLS policies.
 */
export async function createTestProject(
  db: Kysely<Database>,
  tenantId: string,
  overrides?: Partial<Omit<Projects, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>
): Promise<ProjectRow> {
  return await withTestTenantContext(db, tenantId, async (tx) => {
    return await tx
      .insertInto('projects')
      .values({
        tenant_id: tenantId,
        name: overrides?.name || 'Test Project',
        description: overrides?.description || 'A test project',
        status: overrides?.status || 'active',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * Create a test task with optional overrides
 *
 * Sets tenant context before inserting to satisfy RLS policies.
 */
export async function createTestTask(
  db: Kysely<Database>,
  tenantId: string,
  projectId: string,
  overrides?: Partial<Omit<Tasks, 'id' | 'tenant_id' | 'project_id' | 'created_at' | 'updated_at'>>
): Promise<TaskRow> {
  return await withTestTenantContext(db, tenantId, async (tx) => {
    return await tx
      .insertInto('tasks')
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        title: overrides?.title || 'Test Task',
        description: overrides?.description || 'A test task',
        status: overrides?.status || 'pending',
        assigned_to: overrides?.assigned_to || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * Create a complete test scenario with tenant, users, projects, and tasks
 *
 * Useful for quickly setting up realistic test data.
 */
export async function createTestScenario(db: Kysely<Database>): Promise<{
  tenant: TenantRow;
  users: UserRow[];
  projects: ProjectRow[];
  tasks: TaskRow[];
}> {
  // Create tenant
  const tenant = await createTestTenant(db, { name: 'Acme Corp' });

  // Create users
  const owner = await createTestUser(db, tenant.id, {
    name: 'Alice Owner',
    email: 'alice@acme.com',
    role: 'owner',
  });

  const admin = await createTestUser(db, tenant.id, {
    name: 'Bob Admin',
    email: 'bob@acme.com',
    role: 'admin',
  });

  const member = await createTestUser(db, tenant.id, {
    name: 'Charlie Member',
    email: 'charlie@acme.com',
    role: 'member',
  });

  const users = [owner, admin, member];

  // Create projects
  const project1 = await createTestProject(db, tenant.id, {
    name: 'Website Redesign',
    description: 'Redesign company website',
    status: 'active',
  });

  const project2 = await createTestProject(db, tenant.id, {
    name: 'Mobile App',
    description: 'Build mobile application',
    status: 'active',
  });

  const projects = [project1, project2];

  // Create tasks
  const task1 = await createTestTask(db, tenant.id, project1.id, {
    title: 'Design mockups',
    status: 'completed',
    assigned_to: member.id,
  });

  const task2 = await createTestTask(db, tenant.id, project1.id, {
    title: 'Implement frontend',
    status: 'in_progress',
    assigned_to: member.id,
  });

  const task3 = await createTestTask(db, tenant.id, project2.id, {
    title: 'Setup project structure',
    status: 'pending',
    assigned_to: admin.id,
  });

  const tasks = [task1, task2, task3];

  return { tenant, users, projects, tasks };
}
