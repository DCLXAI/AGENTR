create table if not exists tenant_settings (
  tenant_id text primary key,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists oauth_tokens (
  tenant_id text not null,
  provider text not null,
  access_token text not null,
  refresh_token_encrypted text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

create table if not exists conversation_logs (
  id bigserial primary key,
  tenant_id text not null,
  session_id text not null,
  user_message text not null,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists tool_call_logs (
  id bigserial primary key,
  tenant_id text not null,
  session_id text not null,
  tool text not null,
  status text not null,
  latency_ms integer not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists rag_ingest_jobs (
  id bigserial primary key,
  tenant_id text not null default 'default',
  version_tag text not null,
  source_paths jsonb not null default '[]'::jsonb,
  upserted_chunks integer not null default 0,
  status text not null default 'done',
  created_at timestamptz not null default now()
);

