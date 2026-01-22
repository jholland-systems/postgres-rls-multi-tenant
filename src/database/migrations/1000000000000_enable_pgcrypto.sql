-- Migration 000: Enable pgcrypto extension
-- This extension provides cryptographic functions including gen_random_uuid()

-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Verify extension is enabled
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'
  ) THEN
    RAISE EXCEPTION 'pgcrypto extension failed to install';
  END IF;
END
$$;
