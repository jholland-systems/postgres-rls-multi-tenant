-- Migration 004b: Create admin_audit_log table
-- Admin audit log has NO RLS - global tracking of privileged access
-- Access control: app_user has INSERT only, app_admin has SELECT
-- This prevents sensitive audit log from becoming a data leak vector

CREATE TABLE admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID NOT NULL,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,              -- e.g., 'cross_tenant_query', 'admin_override'
    correlation_id TEXT NOT NULL,      -- Request ID for tracing
    reason TEXT,                        -- Why privileged access was needed
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Contextual data: actor_ip, endpoint, target_tenant_id, query_name, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add table and column comments
COMMENT ON TABLE admin_audit_log IS 'Global audit log for privileged access (no RLS). Tracks all cross-tenant queries and admin operations.';
COMMENT ON COLUMN admin_audit_log.actor_id IS 'UUID of the admin who performed the action';
COMMENT ON COLUMN admin_audit_log.actor_email IS 'Email of the admin (for human-readable audit trail)';
COMMENT ON COLUMN admin_audit_log.action IS 'Type of privileged action (e.g., "privileged_cross_tenant_query")';
COMMENT ON COLUMN admin_audit_log.correlation_id IS 'Request correlation ID for distributed tracing';
COMMENT ON COLUMN admin_audit_log.reason IS 'Human-readable justification for privileged access';
COMMENT ON COLUMN admin_audit_log.metadata IS 'Additional context (JSONB): actor_ip, endpoint, target_tenant_id, query_name, etc.';

-- Create indexes for audit log queries
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log(created_at);
CREATE INDEX idx_admin_audit_log_actor_id ON admin_audit_log(actor_id);
CREATE INDEX idx_admin_audit_log_correlation_id ON admin_audit_log(correlation_id);

-- Access control grants (recommended for production)
-- These are commented out for demo purposes (we connect as postgres)
-- In production, uncomment and create appropriate roles:
--
-- REVOKE ALL ON admin_audit_log FROM PUBLIC;
-- GRANT INSERT ON admin_audit_log TO app_user;
-- GRANT SELECT ON admin_audit_log TO app_admin;
