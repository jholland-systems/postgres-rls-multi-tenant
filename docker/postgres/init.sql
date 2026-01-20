-- Initialize database for multi-tenant RLS showcase
-- This script runs automatically when the PostgreSQL container starts

-- Enable extensions that will be needed
-- (Migrations will also enable these, but this ensures they're available)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Create application role (for future use with role-based access)
-- For now, we'll connect as postgres user for simplicity
-- In production, you'd use dedicated roles:
-- CREATE ROLE app_user WITH LOGIN PASSWORD 'secure_password';
-- CREATE ROLE app_admin WITH LOGIN PASSWORD 'secure_admin_password';

-- Set default transaction timeout
ALTER DATABASE multitenantdb SET statement_timeout = '10s';

-- Log successful initialization
\echo 'Database initialized successfully'
\echo 'Extensions enabled: pgcrypto, citext'
\echo 'Ready for migrations'
