-- The business's files folder in the connected drive. The Files page opens here and the
-- assistant looks here first. Null = the drive's top level.
alter table public.settings add column if not exists files_home_id text;
alter table public.settings add column if not exists files_home_name text;
