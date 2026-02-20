create table if not exists lead_signups (
  id bigserial primary key,
  email text not null,
  source text not null default 'homepage',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_signups_created_at
on lead_signups (created_at desc);
