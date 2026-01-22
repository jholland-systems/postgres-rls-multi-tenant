/**
 * Performance Benchmark Script
 *
 * Measures RLS overhead by comparing query performance with and without tenant context.
 * Helps quantify the performance impact of Row Level Security policies.
 *
 * Run with: npm run benchmark
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../database/schema.js';
import { env } from '../config/env.js';

interface BenchmarkResult {
  operation: string;
  withRLS: number;
  withoutRLS: number;
  overhead: number;
  overheadPercent: string;
}

async function main() {
  console.log('='.repeat(80));
  console.log('PostgreSQL RLS Performance Benchmark');
  console.log('='.repeat(80));
  console.log();

  // Create database connections
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    // 1. Setup test data
    console.log('Setting up test data...');
    await setupTestData(db);

    const results: BenchmarkResult[] = [];

    // 2. Benchmark: SELECT all projects (tenant-scoped vs. no context)
    console.log('\n' + '-'.repeat(80));
    console.log('Benchmark 1: SELECT all projects');
    console.log('-'.repeat(80));
    results.push(await benchmarkSelect(db));

    // 3. Benchmark: SELECT with JOIN (projects + tasks)
    console.log('\n' + '-'.repeat(80));
    console.log('Benchmark 2: SELECT with JOIN (projects + tasks)');
    console.log('-'.repeat(80));
    results.push(await benchmarkSelectWithJoin(db));

    // 4. Benchmark: INSERT new project
    console.log('\n' + '-'.repeat(80));
    console.log('Benchmark 3: INSERT new project');
    console.log('-'.repeat(80));
    results.push(await benchmarkInsert(db));

    // 5. Benchmark: UPDATE project
    console.log('\n' + '-'.repeat(80));
    console.log('Benchmark 4: UPDATE project');
    console.log('-'.repeat(80));
    results.push(await benchmarkUpdate(db));

    // 6. Print summary table
    console.log('\n' + '='.repeat(80));
    console.log('Summary');
    console.log('='.repeat(80));
    console.log();
    console.log('| Operation                    | With RLS  | Without RLS | Overhead  | Overhead % |');
    console.log('|------------------------------|-----------|-------------|-----------|------------|');
    results.forEach((r) => {
      console.log(
        `| ${r.operation.padEnd(28)} | ${r.withRLS.toFixed(2).padStart(7)}ms | ${r.withoutRLS.toFixed(2).padStart(9)}ms | ${r.overhead.toFixed(2).padStart(7)}ms | ${r.overheadPercent.padStart(9)} |`
      );
    });
    console.log();

    const avgOverhead =
      results.reduce((sum, r) => sum + parseFloat(r.overheadPercent), 0) / results.length;
    console.log(`Average RLS overhead: ${avgOverhead.toFixed(2)}%`);
    console.log();
    console.log('Note: Expected overhead is typically 5-10% for well-indexed queries.');
    console.log('RLS policies add a WHERE clause filter that PostgreSQL optimizes efficiently.');
    console.log();

    // 7. EXPLAIN ANALYZE examples
    console.log('='.repeat(80));
    console.log('EXPLAIN ANALYZE Examples');
    console.log('='.repeat(80));
    await explainAnalyzeExamples(db);

    // Cleanup
    console.log('\nCleaning up test data...');
    await cleanupTestData(db);
    console.log('Done!');
  } finally {
    await db.destroy();
    await pool.end();
  }
}

/**
 * Setup test data: Create tenants and projects for benchmarking
 */
async function setupTestData(db: Kysely<Database>): Promise<void> {
  // Create 3 tenants with 1000 projects each
  const tenantCount = 3;
  const projectsPerTenant = 1000;

  for (let i = 0; i < tenantCount; i++) {
    const tenant = await db
      .insertInto('tenants')
      .values({
        name: `Benchmark Tenant ${i + 1}`,
        slug: `benchmark-tenant-${i + 1}-${Date.now()}`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    console.log(`  Created tenant: ${tenant.name} (${tenant.id})`);

    // Batch insert projects
    const projects: Array<{
      tenant_id: string;
      name: string;
      description: string;
      status: 'active' | 'archived' | 'completed';
    }> = [];
    for (let j = 0; j < projectsPerTenant; j++) {
      projects.push({
        tenant_id: tenant.id,
        name: `Project ${j + 1}`,
        description: `Benchmark project ${j + 1} for tenant ${i + 1}`,
        status: 'active' as const,
      });
    }

    // Insert in batches of 100
    for (let k = 0; k < projects.length; k += 100) {
      const batch = projects.slice(k, k + 100);
      await db.transaction().execute(async (tx) => {
        // Set tenant context for RLS policy
        await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
        await tx.insertInto('projects').values(batch).execute();
      });
    }

    console.log(`  Created ${projectsPerTenant} projects for ${tenant.name}`);
  }

  console.log(`Total: ${tenantCount} tenants, ${tenantCount * projectsPerTenant} projects`);
}

/**
 * Cleanup test data
 */
async function cleanupTestData(db: Kysely<Database>): Promise<void> {
  await sql.raw(`
    DELETE FROM projects WHERE name LIKE 'Project %';
    DELETE FROM tenants WHERE slug LIKE 'benchmark-tenant-%';
  `).execute(db);
}

/**
 * Benchmark: SELECT all projects for a tenant
 */
async function benchmarkSelect(db: Kysely<Database>): Promise<BenchmarkResult> {
  const tenant = await db
    .selectFrom('tenants')
    .where('slug', 'like', 'benchmark-tenant-%')
    .selectAll()
    .executeTakeFirst();

  if (!tenant) throw new Error('No benchmark tenant found');

  const iterations = 100;

  // With RLS (tenant context set)
  const startWithRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
      await tx.selectFrom('projects').selectAll().execute();
    });
  }
  const endWithRLS = performance.now();
  const avgWithRLS = (endWithRLS - startWithRLS) / iterations;

  // Without RLS (superadmin, see all tenants)
  const startWithoutRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw("SET LOCAL app.is_superadmin = 'true'").execute(tx);
      await tx.selectFrom('projects').selectAll().execute();
    });
  }
  const endWithoutRLS = performance.now();
  const avgWithoutRLS = (endWithoutRLS - startWithoutRLS) / iterations;

  const overhead = avgWithRLS - avgWithoutRLS;
  const overheadPercent = ((overhead / avgWithoutRLS) * 100).toFixed(2);

  console.log(`  With RLS:    ${avgWithRLS.toFixed(2)}ms (avg over ${iterations} iterations)`);
  console.log(
    `  Without RLS: ${avgWithoutRLS.toFixed(2)}ms (avg over ${iterations} iterations)`
  );
  console.log(`  Overhead:    ${overhead.toFixed(2)}ms (${overheadPercent}%)`);

  return {
    operation: 'SELECT all projects',
    withRLS: avgWithRLS,
    withoutRLS: avgWithoutRLS,
    overhead,
    overheadPercent,
  };
}

/**
 * Benchmark: SELECT with JOIN (projects + tasks)
 */
async function benchmarkSelectWithJoin(db: Kysely<Database>): Promise<BenchmarkResult> {
  const tenant = await db
    .selectFrom('tenants')
    .where('slug', 'like', 'benchmark-tenant-%')
    .selectAll()
    .executeTakeFirst();

  if (!tenant) throw new Error('No benchmark tenant found');

  const iterations = 100;

  // With RLS
  const startWithRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
      await tx
        .selectFrom('projects')
        .leftJoin('tasks', 'tasks.project_id', 'projects.id')
        .select(['projects.id', 'projects.name', 'tasks.id as task_id'])
        .execute();
    });
  }
  const endWithRLS = performance.now();
  const avgWithRLS = (endWithRLS - startWithRLS) / iterations;

  // Without RLS
  const startWithoutRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw("SET LOCAL app.is_superadmin = 'true'").execute(tx);
      await tx
        .selectFrom('projects')
        .leftJoin('tasks', 'tasks.project_id', 'projects.id')
        .select(['projects.id', 'projects.name', 'tasks.id as task_id'])
        .execute();
    });
  }
  const endWithoutRLS = performance.now();
  const avgWithoutRLS = (endWithoutRLS - startWithoutRLS) / iterations;

  const overhead = avgWithRLS - avgWithoutRLS;
  const overheadPercent = ((overhead / avgWithoutRLS) * 100).toFixed(2);

  console.log(`  With RLS:    ${avgWithRLS.toFixed(2)}ms (avg over ${iterations} iterations)`);
  console.log(
    `  Without RLS: ${avgWithoutRLS.toFixed(2)}ms (avg over ${iterations} iterations)`
  );
  console.log(`  Overhead:    ${overhead.toFixed(2)}ms (${overheadPercent}%)`);

  return {
    operation: 'SELECT with JOIN',
    withRLS: avgWithRLS,
    withoutRLS: avgWithoutRLS,
    overhead,
    overheadPercent,
  };
}

/**
 * Benchmark: INSERT new project
 */
async function benchmarkInsert(db: Kysely<Database>): Promise<BenchmarkResult> {
  const tenant = await db
    .selectFrom('tenants')
    .where('slug', 'like', 'benchmark-tenant-%')
    .selectAll()
    .executeTakeFirst();

  if (!tenant) throw new Error('No benchmark tenant found');

  const iterations = 100;

  // With RLS
  const startWithRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
      await tx
        .insertInto('projects')
        .values({
          tenant_id: tenant.id,
          name: `Benchmark Insert ${i}`,
          status: 'active',
        })
        .execute();
    });
  }
  const endWithRLS = performance.now();
  const avgWithRLS = (endWithRLS - startWithRLS) / iterations;

  // Without RLS (note: still need to provide tenant_id, but no RLS check)
  const startWithoutRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw("SET LOCAL app.is_superadmin = 'true'").execute(tx);
      await tx
        .insertInto('projects')
        .values({
          tenant_id: tenant.id,
          name: `Benchmark Insert No RLS ${i}`,
          status: 'active',
        })
        .execute();
    });
  }
  const endWithoutRLS = performance.now();
  const avgWithoutRLS = (endWithoutRLS - startWithoutRLS) / iterations;

  const overhead = avgWithRLS - avgWithoutRLS;
  const overheadPercent = ((overhead / avgWithoutRLS) * 100).toFixed(2);

  console.log(`  With RLS:    ${avgWithRLS.toFixed(2)}ms (avg over ${iterations} iterations)`);
  console.log(
    `  Without RLS: ${avgWithoutRLS.toFixed(2)}ms (avg over ${iterations} iterations)`
  );
  console.log(`  Overhead:    ${overhead.toFixed(2)}ms (${overheadPercent}%)`);

  // Cleanup benchmark inserts
  await db
    .deleteFrom('projects')
    .where('name', 'like', 'Benchmark Insert%')
    .execute();

  return {
    operation: 'INSERT project',
    withRLS: avgWithRLS,
    withoutRLS: avgWithoutRLS,
    overhead,
    overheadPercent,
  };
}

/**
 * Benchmark: UPDATE project
 */
async function benchmarkUpdate(db: Kysely<Database>): Promise<BenchmarkResult> {
  const tenant = await db
    .selectFrom('tenants')
    .where('slug', 'like', 'benchmark-tenant-%')
    .selectAll()
    .executeTakeFirst();

  if (!tenant) throw new Error('No benchmark tenant found');

  // Get a project to update
  const project = await db
    .selectFrom('projects')
    .where('tenant_id', '=', tenant.id)
    .selectAll()
    .executeTakeFirst();

  if (!project) throw new Error('No project found for benchmark');

  const iterations = 100;

  // With RLS
  const startWithRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
      await tx
        .updateTable('projects')
        .set({ name: `Updated ${i}` })
        .where('id', '=', project.id)
        .execute();
    });
  }
  const endWithRLS = performance.now();
  const avgWithRLS = (endWithRLS - startWithRLS) / iterations;

  // Without RLS
  const startWithoutRLS = performance.now();
  for (let i = 0; i < iterations; i++) {
    await db.transaction().execute(async (tx) => {
      await sql.raw("SET LOCAL app.is_superadmin = 'true'").execute(tx);
      await tx
        .updateTable('projects')
        .set({ name: `Updated No RLS ${i}` })
        .where('id', '=', project.id)
        .execute();
    });
  }
  const endWithoutRLS = performance.now();
  const avgWithoutRLS = (endWithoutRLS - startWithoutRLS) / iterations;

  const overhead = avgWithRLS - avgWithoutRLS;
  const overheadPercent = ((overhead / avgWithoutRLS) * 100).toFixed(2);

  console.log(`  With RLS:    ${avgWithRLS.toFixed(2)}ms (avg over ${iterations} iterations)`);
  console.log(
    `  Without RLS: ${avgWithoutRLS.toFixed(2)}ms (avg over ${iterations} iterations)`
  );
  console.log(`  Overhead:    ${overhead.toFixed(2)}ms (${overheadPercent}%)`);

  return {
    operation: 'UPDATE project',
    withRLS: avgWithRLS,
    withoutRLS: avgWithoutRLS,
    overhead,
    overheadPercent,
  };
}

/**
 * Print EXPLAIN ANALYZE examples
 */
async function explainAnalyzeExamples(db: Kysely<Database>): Promise<void> {
  const tenant = await db
    .selectFrom('tenants')
    .where('slug', 'like', 'benchmark-tenant-%')
    .selectAll()
    .executeTakeFirst();

  if (!tenant) throw new Error('No benchmark tenant found');

  console.log('\n1. SELECT with RLS (tenant-scoped):');
  console.log('-'.repeat(80));
  const explainWithRLS = await db.transaction().execute(async (tx) => {
    await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
    return await sql.raw(`
      EXPLAIN ANALYZE
      SELECT * FROM projects
      WHERE status = 'active'
    `).execute(tx);
  });
  console.log(explainWithRLS.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n2. SELECT without RLS (privileged access):');
  console.log('-'.repeat(80));
  const explainWithoutRLS = await db.transaction().execute(async (tx) => {
    await sql.raw("SET LOCAL app.is_superadmin = 'true'").execute(tx);
    return await sql.raw(`
      EXPLAIN ANALYZE
      SELECT * FROM projects
      WHERE status = 'active'
    `).execute(tx);
  });
  console.log(explainWithoutRLS.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n3. JOIN with RLS:');
  console.log('-'.repeat(80));
  const explainJoinWithRLS = await db.transaction().execute(async (tx) => {
    await sql.raw(`SET LOCAL app.current_tenant_id = '${tenant.id}'`).execute(tx);
    return await sql.raw(`
      EXPLAIN ANALYZE
      SELECT p.id, p.name, t.title
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.status = 'active'
    `).execute(tx);
  });
  console.log(explainJoinWithRLS.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\nKey observations:');
  console.log('- RLS adds a WHERE clause filter on tenant_id');
  console.log('- PostgreSQL uses the tenant_id index efficiently');
  console.log('- Query planner optimizes RLS policies like normal WHERE clauses');
  console.log('- Overhead is typically 5-10% for well-indexed queries');
}

// Run benchmark
main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
