-- Migration 002: Create users table
-- Users table WITH RLS (tenant-scoped)

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email CITEXT NOT NULL CHECK (position('@' IN email) > 1),  -- Case-insensitive email with validation
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, email)  -- Emails unique within tenant (citext ensures case-insensitive)
);

-- Add table and column comments
COMMENT ON TABLE users IS 'Tenant-scoped users table with RLS. Emails are case-insensitive via citext.';
COMMENT ON COLUMN users.tenant_id IS 'Foreign key to tenants table. CASCADE delete removes users when tenant is deleted.';
COMMENT ON COLUMN users.email IS 'Case-insensitive email (citext). Unique within tenant.';
COMMENT ON COLUMN users.role IS 'User role within tenant: member, admin, or owner';

-- Create index on tenant_id for RLS queries
CREATE INDEX idx_users_tenant_id ON users(tenant_id);

-- Note: UNIQUE(tenant_id, email) automatically creates a unique btree index
-- No separate index needed for this combination
