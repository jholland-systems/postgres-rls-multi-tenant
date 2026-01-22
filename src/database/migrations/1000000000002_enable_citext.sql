-- Migration 001b: Enable citext extension
-- This extension provides case-insensitive text type for email fields
-- Ensures user@example.com == USER@EXAMPLE.COM (industry standard behavior)

-- Enable citext for case-insensitive text
CREATE EXTENSION IF NOT EXISTS citext;

-- Verify extension is enabled
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'citext'
  ) THEN
    RAISE EXCEPTION 'citext extension failed to install';
  END IF;
END
$$;
