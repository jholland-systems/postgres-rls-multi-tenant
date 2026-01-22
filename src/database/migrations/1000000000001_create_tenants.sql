-- Migration 001: Create tenants table
-- Tenants table has NO RLS (it's the root of our tenant hierarchy)

CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),  -- DNS-safe slug format
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add table comment for documentation
COMMENT ON TABLE tenants IS 'Root tenant table - no RLS. Each tenant represents an isolated customer/organization.';
COMMENT ON COLUMN tenants.slug IS 'URL-safe identifier for tenant (DNS-safe: lowercase alphanumeric and hyphens)';

-- Create index on slug for lookups
CREATE INDEX idx_tenants_slug ON tenants(slug);
