-- Migration 004: Create tasks table
-- Tasks table WITH RLS (tenant-scoped)
-- Note: project_id and assigned_to defined WITHOUT inline FKs
-- Composite FKs will be added in migration 004d (after all tables exist)

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID NOT NULL,  -- FK added later as composite constraint (tenant_id, project_id)
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked')),
    assigned_to UUID NULL,  -- Tenant-scoped user id. Nullable by design (supports ON DELETE SET NULL in composite FK)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add table and column comments
COMMENT ON TABLE tasks IS 'Tenant-scoped tasks table with RLS. Tasks belong to projects and can be assigned to users.';
COMMENT ON COLUMN tasks.tenant_id IS 'Foreign key to tenants table. CASCADE delete removes tasks when tenant is deleted.';
COMMENT ON COLUMN tasks.project_id IS 'Reference to project (composite FK enforced in migration 004d)';
COMMENT ON COLUMN tasks.assigned_to IS 'Reference to user within same tenant (composite FK enforced in migration 004d). NULL = unassigned.';
COMMENT ON COLUMN tasks.status IS 'Task status: pending, in_progress, completed, or blocked';

-- Create indexes for performance
CREATE INDEX idx_tasks_tenant_id ON tasks(tenant_id);
CREATE INDEX idx_tasks_tenant_status ON tasks(tenant_id, status);  -- Common filtering in task lists
