-- Signed-in users only ever need row access through policies. Remove table-level powers
-- that bypass row security.
revoke truncate, references, trigger on
  public.agent_chats, public.agent_chat_messages, public.agent_memory, public.agent_changes,
  public.agent_runs, public.agent_actions, public.file_links, public.file_changes,
  public.team_members, public.settings
from authenticated, anon;
