/**
 * Database schema types for Kysely
 *
 * This file will be generated from the database schema after running migrations.
 * For now, we define the types manually based on our planned schema.
 *
 * In production, you'd use kysely-codegen to auto-generate this from the database:
 * ```bash
 * npx kysely-codegen --out-file src/database/schema.ts
 * ```
 */

import type { ColumnType, Selectable } from 'kysely';

/**
 * Represents a timestamp column in the database.
 * Generated columns are never inserted/updated, but can be selected.
 */
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * Tenants table (no RLS)
 */
export interface Tenants {
  id: Generated<string>;
  name: string;
  slug: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * Users table (with RLS)
 */
export interface Users {
  id: Generated<string>;
  tenant_id: string;
  email: string; // Using citext in database
  name: string;
  role: 'member' | 'admin' | 'owner';
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * Projects table (with RLS)
 */
export interface Projects {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'completed';
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * Tasks table (with RLS)
 */
export interface Tasks {
  id: Generated<string>;
  tenant_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  assigned_to: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * Admin audit log (no RLS - global tracking)
 */
export interface AdminAuditLog {
  id: Generated<string>;
  actor_id: string;
  actor_email: string;
  action: string;
  correlation_id: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Generated<Timestamp>;
}

/**
 * Database interface with all tables
 */
export interface Database {
  tenants: Tenants;
  users: Users;
  projects: Projects;
  tasks: Tasks;
  admin_audit_log: AdminAuditLog;
}

/**
 * Selectable types (for query results)
 * These represent the actual row types returned from SELECT queries
 */
export type TenantRow = Selectable<Tenants>;
export type UserRow = Selectable<Users>;
export type ProjectRow = Selectable<Projects>;
export type TaskRow = Selectable<Tasks>;
export type AdminAuditLogRow = Selectable<AdminAuditLog>;
