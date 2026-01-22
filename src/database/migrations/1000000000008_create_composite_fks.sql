-- Migration 004d: Composite foreign keys and indexes
-- Tenant boundary enforcement with composite foreign keys (defense-in-depth beyond RLS)
-- This prevents tasks from referencing projects/users in different tenants at the constraint level

-- Add supporting UNIQUE constraints for composite FKs
-- These allow other tables to reference (tenant_id, id) pairs

ALTER TABLE projects
    ADD CONSTRAINT projects_tenant_id_id_unique UNIQUE (tenant_id, id);

COMMENT ON CONSTRAINT projects_tenant_id_id_unique ON projects
    IS 'Enables composite FK references to (tenant_id, id). Enforces tenant boundary at constraint level.';

ALTER TABLE users
    ADD CONSTRAINT users_tenant_id_id_unique UNIQUE (tenant_id, id);

COMMENT ON CONSTRAINT users_tenant_id_id_unique ON users
    IS 'Enables composite FK references to (tenant_id, id). Enforces tenant boundary at constraint level.';

-- Add composite foreign keys to tasks table
-- These enforce tenant boundaries: tasks can only reference projects/users in the SAME tenant

ALTER TABLE tasks
    ADD CONSTRAINT tasks_tenant_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects (tenant_id, id)
    ON DELETE CASCADE;

COMMENT ON CONSTRAINT tasks_tenant_project_fk ON tasks
    IS 'Composite FK enforces tenant boundary: tasks can only reference projects in the same tenant';

ALTER TABLE tasks
    ADD CONSTRAINT tasks_tenant_assigned_to_fk
    FOREIGN KEY (tenant_id, assigned_to)
    REFERENCES users (tenant_id, id)
    ON DELETE SET NULL;  -- Allow unassigned tasks (assigned_to = NULL)

COMMENT ON CONSTRAINT tasks_tenant_assigned_to_fk ON tasks
    IS 'Composite FK enforces tenant boundary: tasks can only be assigned to users in the same tenant. ON DELETE SET NULL allows task to become unassigned.';

-- Create indexes for composite FK performance
-- These speed up:
-- 1. Composite FK constraint enforcement lookups
-- 2. JOIN operations on (tenant_id, project_id) and (tenant_id, assigned_to)

CREATE INDEX idx_tasks_tenant_project_id ON tasks(tenant_id, project_id);
COMMENT ON INDEX idx_tasks_tenant_project_id
    IS 'Composite index for FK enforcement and project-based queries within tenant';

CREATE INDEX idx_tasks_tenant_assigned_to ON tasks(tenant_id, assigned_to);
COMMENT ON INDEX idx_tasks_tenant_assigned_to
    IS 'Composite index for FK enforcement and user assignment queries within tenant';

-- Production note: For large existing tables, use NOT VALID then VALIDATE CONSTRAINT
-- to avoid long locks during FK addition:
--   ALTER TABLE tasks ADD CONSTRAINT tasks_tenant_project_fk ... NOT VALID;
--   ALTER TABLE tasks VALIDATE CONSTRAINT tasks_tenant_project_fk;
--
-- For this demo with empty tables, NOT VALID is unnecessary.
