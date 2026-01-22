-- Migration 003: Create projects table
-- Projects table WITH RLS (tenant-scoped)

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add table and column comments
COMMENT ON TABLE projects IS 'Tenant-scoped projects table with RLS. Projects belong to a single tenant.';
COMMENT ON COLUMN projects.tenant_id IS 'Foreign key to tenants table. CASCADE delete removes projects when tenant is deleted.';
COMMENT ON COLUMN projects.status IS 'Project status: active, archived, or completed';

-- Create indexes for performance
CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX idx_projects_tenant_status ON projects(tenant_id, status);  -- Common filtering pattern
