create table if not exists balance_settings (
  user_id text primary key,
  claude_plan text not null default 'claude-max-5x',
  codex_plan text not null default 'chatgpt-plus',
  week_boost_pct integer not null default 50,
  updated_at timestamptz not null default now()
);
