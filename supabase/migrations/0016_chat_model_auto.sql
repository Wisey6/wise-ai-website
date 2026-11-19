-- The assistant's model setting: 'auto' (Haiku, escalating to Sonnet when a turn needs it) is the
-- new default; 'haiku' | 'sonnet' | 'opus' pin one model. Older full model ids stay valid.
alter table public.settings drop constraint if exists settings_agent_chat_model_check;
alter table public.settings add constraint settings_agent_chat_model_check
  check (agent_chat_model in ('auto','haiku','sonnet','opus','claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5'));
alter table public.settings alter column agent_chat_model set default 'auto';
