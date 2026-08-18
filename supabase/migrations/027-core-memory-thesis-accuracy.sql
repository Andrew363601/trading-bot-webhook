ALTER TABLE hermes_core_memory
  ADD COLUMN IF NOT EXISTS thesis_accurate boolean,
  ADD COLUMN IF NOT EXISTS thesis_summary text;

COMMENT ON COLUMN hermes_core_memory.thesis_accurate IS
  'Autopsy evaluation: was the thesis correct even if the trade lost,
   or flawed even if it won?';
COMMENT ON COLUMN hermes_core_memory.thesis_summary IS
  'One-line summary of what the thesis was trying to capture.';
