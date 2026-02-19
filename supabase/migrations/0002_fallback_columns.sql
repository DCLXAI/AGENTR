alter table conversation_logs add column if not exists why_fallback text;
alter table tool_call_logs add column if not exists why_fallback text;
alter table rag_ingest_jobs add column if not exists why_fallback text;

create index if not exists idx_conversation_logs_fallback
on conversation_logs (why_fallback, created_at desc)
where why_fallback is not null;

