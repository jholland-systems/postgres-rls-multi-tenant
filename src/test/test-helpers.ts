import { Kysely, sql } from 'kysely';
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
