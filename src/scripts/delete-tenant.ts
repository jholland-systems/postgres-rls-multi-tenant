/**
 * Safe Tenant Deletion Script
 *
 * Deletes a tenant and all related data with confirmation prompt.
 * Demonstrates understanding of data lifecycle management.
 *
 * Usage:
 *   npm run delete-tenant -- --tenant-id=<uuid>
 *   npm run delete-tenant -- --tenant-slug=<slug>
 *
 * Example:
 *   npm run delete-tenant -- --tenant-slug=acme-corp
 *   npm run delete-tenant -- --tenant-id=123e4567-e89b-12d3-a456-426614174000
 */

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../database/schema.js';
import { env } from '../config/env.js';
import * as readline from 'readline';

interface DeletionStats {
  users: number;
  projects: number;
  tasks: number;
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const tenantIdArg = args.find((arg) => arg.startsWith('--tenant-id='));
  const tenantSlugArg = args.find((arg) => arg.startsWith('--tenant-slug='));

  if (!tenantIdArg && !tenantSlugArg) {
    console.error('Error: Must provide either --tenant-id or --tenant-slug');
    console.error('\nUsage:');
    console.error('  npm run delete-tenant -- --tenant-id=<uuid>');
    console.error('  npm run delete-tenant -- --tenant-slug=<slug>');
    console.error('\nExample:');
    console.error('  npm run delete-tenant -- --tenant-slug=acme-corp');
    process.exit(1);
  }

  const tenantId = tenantIdArg?.split('=')[1];
  const tenantSlug = tenantSlugArg?.split('=')[1];

  // Create database connection
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    console.log('='.repeat(80));
    console.log('Tenant Deletion Script');
    console.log('='.repeat(80));
    console.log();

    // 1. Find the tenant
    console.log('Step 1: Finding tenant...');
    let tenant;
    if (tenantId) {
      tenant = await db
        .selectFrom('tenants')
        .where('id', '=', tenantId)
        .selectAll()
        .executeTakeFirst();
    } else if (tenantSlug) {
      tenant = await db
        .selectFrom('tenants')
        .where('slug', '=', tenantSlug)
        .selectAll()
        .executeTakeFirst();
    }

    if (!tenant) {
      console.error(`\nError: Tenant not found`);
      if (tenantId) console.error(`  Tenant ID: ${tenantId}`);
      if (tenantSlug) console.error(`  Tenant slug: ${tenantSlug}`);
      process.exit(1);
    }

    console.log(`  Found tenant: ${tenant.name} (${tenant.slug})`);
    console.log(`  Tenant ID: ${tenant.id}`);
    console.log();

    // 2. Count related data
    console.log('Step 2: Analyzing related data...');
    const stats = await getDeletionStats(db, tenant.id);

    console.log(`  Users:    ${stats.users}`);
    console.log(`  Projects: ${stats.projects}`);
    console.log(`  Tasks:    ${stats.tasks}`);
    console.log();

    const totalRecords = stats.users + stats.projects + stats.tasks;
    if (totalRecords === 0) {
      console.log('  No related data found.');
    } else {
      console.log(`  Total records to delete: ${totalRecords}`);
    }
    console.log();

    // 3. Confirmation prompt
    console.log('='.repeat(80));
    console.log('WARNING: This action is IRREVERSIBLE');
    console.log('='.repeat(80));
    console.log();
    console.log(`You are about to permanently delete tenant: ${tenant.name}`);
    console.log(`Tenant ID: ${tenant.id}`);
    console.log(`Slug: ${tenant.slug}`);
    console.log();
    console.log('This will delete:');
    console.log(`  - The tenant record`);
    console.log(`  - ${stats.users} user(s)`);
    console.log(`  - ${stats.projects} project(s)`);
    console.log(`  - ${stats.tasks} task(s)`);
    console.log();

    const confirmed = await promptConfirmation(
      `Type the tenant slug "${tenant.slug}" to confirm deletion`
    );

    if (confirmed !== tenant.slug) {
      console.log('\nDeletion cancelled: Slug did not match.');
      process.exit(0);
    }

    // 4. Delete tenant (CASCADE will delete all related data)
    console.log('\nStep 3: Deleting tenant and related data...');
    const startTime = Date.now();

    await db
      .deleteFrom('tenants')
      .where('id', '=', tenant.id)
      .execute();

    const duration = Date.now() - startTime;

    console.log(`  Deleted in ${duration}ms`);
    console.log();

    // 5. Verify deletion
    console.log('Step 4: Verifying deletion...');
    const verification = await getDeletionStats(db, tenant.id);
    const tenantStillExists = await db
      .selectFrom('tenants')
      .where('id', '=', tenant.id)
      .selectAll()
      .executeTakeFirst();

    if (tenantStillExists) {
      console.error('  ERROR: Tenant still exists in database!');
      process.exit(1);
    }

    if (verification.users > 0 || verification.projects > 0 || verification.tasks > 0) {
      console.error('  ERROR: Related data still exists in database!');
      console.error(`    Users: ${verification.users}`);
      console.error(`    Projects: ${verification.projects}`);
      console.error(`    Tasks: ${verification.tasks}`);
      process.exit(1);
    }

    console.log('  Verification successful: All data deleted.');
    console.log();

    console.log('='.repeat(80));
    console.log('Tenant deletion completed successfully');
    console.log('='.repeat(80));
    console.log();
    console.log(`Deleted tenant: ${tenant.name} (${tenant.slug})`);
    console.log(`Total records deleted: ${totalRecords + 1} (including tenant)`);
    console.log();
  } catch (err) {
    console.error('\nError during tenant deletion:');
    console.error(err);
    process.exit(1);
  } finally {
    await db.destroy();
    await pool.end();
  }
}

/**
 * Get deletion statistics for a tenant
 */
async function getDeletionStats(db: Kysely<Database>, tenantId: string): Promise<DeletionStats> {
  const [users, projects, tasks] = await Promise.all([
    db
      .selectFrom('users')
      .where('tenant_id', '=', tenantId)
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst(),
    db
      .selectFrom('projects')
      .where('tenant_id', '=', tenantId)
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst(),
    db
      .selectFrom('tasks')
      .where('tenant_id', '=', tenantId)
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst(),
  ]);

  return {
    users: Number(users?.count || 0),
    projects: Number(projects?.count || 0),
    tasks: Number(tasks?.count || 0),
  };
}

/**
 * Prompt user for confirmation
 */
async function promptConfirmation(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Run script
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
