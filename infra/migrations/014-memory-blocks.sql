-- Migration for memory_blocks table - core memory blocks for Shelly
-- This table stores small, editable memory blocks that are always injected into Shelly's context

CREATE TABLE memory_blocks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace     TEXT NOT NULL,
  block_name    TEXT NOT NULL,
  content       TEXT NOT NULL,
  char_limit    INTEGER NOT NULL DEFAULT 2000,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  
  -- Ensure unique block names per namespace
  UNIQUE(namespace, block_name)
);

-- Index for fast lookups by namespace and block_name
CREATE INDEX memory_blocks_namespace_name_idx ON memory_blocks (namespace, block_name);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_memory_blocks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_memory_blocks_updated_at 
  BEFORE UPDATE ON memory_blocks 
  FOR EACH ROW EXECUTE PROCEDURE update_memory_blocks_updated_at();