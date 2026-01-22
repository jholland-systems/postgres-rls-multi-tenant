import { Kysely, PostgresDialect, Transaction, CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { Database } from './schema.js';

// 1. The Raw Pool (Internal use only)
// Production-ready pool configuration with statement timeout
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  statement_timeout: env.DB_STATEMENT_TIMEOUT, // 10s timeout prevents runaway queries
  // Production-ready: Prevents long-running queries from exhausting connection slots
  // Especially important during migrations and analytics queries
});

// Connection error handling
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
  process.exit(-1);
});

// Log pool events in development
if (env.NODE_ENV === 'development') {
  pool.on('connect', () => {
    logger.debug('New PostgreSQL connection established');
  });
  pool.on('remove', () => {
    logger.debug('PostgreSQL connection removed from pool');
  });
}

// 2. The Base Kysely Instance (Internal use only - NOT EXPORTED)
// This is NEVER exported to prevent "naked query" trap
const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
  log: (event) => {
    if (event.level === 'query') {
      logger.debug(
        {
          query: event.query.sql,
          params: event.query.parameters,
          duration: event.queryDurationMillis,
        },
        'Database query executed'
      );
    } else if (event.level === 'error') {
      logger.error({ error: event.error }, 'Database query error');
    }
  },
});

// 3. Define a "Branded Type" for the Transaction
// This prevents developers from passing raw 'db' where 'tx' is expected at compile time
// The __brand property is a phantom type (never actually exists at runtime)
export type TenantTransaction = Transaction<Database> & {
  __brand: 'tenant-aware';
};

// 4. Export ONLY the Factory Functions (Primary Pattern)
// This is the core of our "Scoped Database Factory" pattern

/**
 * Executes a callback within a tenant-scoped transaction.
 *
 * CRITICAL: This is the PRIMARY way to interact with tenant-aware tables.
 * The transaction is automatically configured with SET LOCAL app.current_tenant_id.
 *
 * @param tenantId - UUID of the tenant context
 * @param callback - Function to execute with tenant-scoped transaction
 * @returns Result of the callback
 *
 * @example
 * ```typescript
 * const projects = await withTenantContext(req.tenantId, async (tx) => {
 *   return await tx.selectFrom('projects').selectAll().execute();
 * });
 * ```
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (tx: TenantTransaction) => Promise<T>
): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    try {
      // A. Set tenant context (transaction-scoped with SET LOCAL)
      await tx.executeQuery(
        CompiledQuery.raw('SET LOCAL app.current_tenant_id = $1', [tenantId])
      );

      logger.debug({ tenantId }, 'Tenant context set');

      // B. Run callback with branded transaction
      return await callback(tx as TenantTransaction);
    } finally {
      // C. Safety cleanup (defense in depth for pooler edge cases)
      // SET LOCAL should auto-reset on COMMIT/ROLLBACK, but we explicitly
      // RESET to protect against external pooler bugs (PgBouncer, RDS Proxy)
      try {
        // CRITICAL: Reset BOTH variables to prevent privilege leakage
        // If app.is_superadmin was set elsewhere, it must be cleared
        await tx.executeQuery(CompiledQuery.raw('RESET app.current_tenant_id'));
        await tx.executeQuery(CompiledQuery.raw('RESET app.is_superadmin'));
        logger.debug('Tenant context reset');
      } catch (err) {
        // Ignore RESET errors (transaction may already be rolled back)
        logger.debug({ err }, 'Error resetting tenant context (ignored)');
      }
    }
  });
}

/**
 * Executes a callback with system-level database access (NO tenant context).
 *
 * Use for non-tenant operations like:
 * - Creating/reading/updating tenants table itself
 * - Platform-level operations that don't belong to a specific tenant
 *
 * @param callback - Function to execute with system-level database access
 * @returns Result of the callback
 *
 * @example
 * ```typescript
 * const tenant = await withSystemContext(async (db) => {
 *   return await db.insertInto('tenants')
 *     .values({ name: 'Acme Corp', slug: 'acme' })
 *     .returningAll()
 *     .executeTakeFirstOrThrow();
 * });
 * ```
 */
export async function withSystemContext<T>(
  callback: (db: Kysely<Database>) => Promise<T>
): Promise<T> {
  // System operations don't set tenant context
  // Use for: tenant CRUD, platform-level operations
  logger.debug('Executing system-level database operation');
  return await callback(db);
}

/**
 * Executes a callback with privileged access (cross-tenant queries).
 *
 * DANGER: This bypasses tenant isolation. Use ONLY for:
 * - Platform analytics
 * - Billing aggregation
 * - Audit log queries
 * - Customer support tooling
 *
 * MANDATORY: Every privileged query is audited in admin_audit_log.
 *
 * @param actorId - UUID of the admin performing the action
 * @param actorEmail - Email of the admin (for audit trail)
 * @param correlationId - Request correlation ID (for tracing)
 * @param reason - Human-readable reason for privileged access
 * @param callback - Function to execute with privileged access
 * @returns Result of the callback
 *
 * @example
 * ```typescript
 * const allProjects = await withPrivilegedContext(
 *   req.user.id,
 *   req.user.email,
 *   req.correlationId,
 *   'Monthly billing aggregation',
 *   async (tx) => {
 *     return await tx.selectFrom('projects').selectAll().execute();
 *   }
 * );
 * ```
 */
export async function withPrivilegedContext<T>(
  actorId: string,
  actorEmail: string,
  correlationId: string,
  reason: string,
  callback: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    try {
      // Set superadmin flag (NO tenant_id - see all tenants)
      await tx.executeQuery(
        CompiledQuery.raw("SET LOCAL app.is_superadmin = 'true'")
      );

      logger.warn(
        { actorId, actorEmail, correlationId, reason },
        'Privileged access granted'
      );

      // CRITICAL: Audit log MUST be written in same transaction
      // If this fails, the entire privileged operation rolls back
      await tx
        .insertInto('admin_audit_log')
        .values({
          actor_id: actorId,
          actor_email: actorEmail,
          action: 'privileged_cross_tenant_query',
          correlation_id: correlationId,
          reason: reason,
          metadata: {
            timestamp: new Date().toISOString(),
          },
        })
        .execute();

      return await callback(tx);
    } finally {
      try {
        await tx.executeQuery(CompiledQuery.raw('RESET app.is_superadmin'));
        logger.debug('Privileged context reset');
      } catch (err) {
        logger.debug({ err }, 'Error resetting privileged context (ignored)');
      }
    }
  });
}

/**
 * Gracefully shuts down the database pool.
 * Call this on application shutdown to ensure all connections are closed.
 */
export async function closeDatabase(): Promise<void> {
  logger.info('Closing database connection pool');
  await db.destroy();
  await pool.end();
  logger.info('Database connection pool closed');
}

// Export db instance ONLY for migrations and scripts
// DO NOT import this in application code - use factory functions instead
export { db as __dangerouslyGetRawDatabase };
