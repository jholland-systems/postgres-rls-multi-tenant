import { Kysely, sql, Transaction, CompiledQuery } from 'kysely';
import type { Database } from '../database/schema.js';

/**
 * Test helper for executing queries with tenant context
 *
 * Similar to withTenantContext but works with test database instances.
 */
export async function withTestTenantContext<T>(
  db: Kysely<Database>,
  tenantId: string,
  callback: (tx: any) => Promise<T>
): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    // Set tenant context - use raw SQL with proper string format
    await sql.raw(`SET LOCAL app.current_tenant_id = '${tenantId}'`).execute(tx);

    // Execute callback
    return await callback(tx);
  });
}

/**
 * Test helper for executing queries with privileged access (cross-tenant)
 *
 * Similar to withPrivilegedContext but works with test database instances.
 * Includes audit logging for all privileged access.
 */
export async function withTestPrivilegedContext<T>(
  db: Kysely<Database>,
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
      } catch (err) {
        // Ignore RESET errors (transaction may already be rolled back)
      }
    }
  });
}
