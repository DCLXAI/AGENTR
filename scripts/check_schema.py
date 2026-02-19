#!/usr/bin/env python3
import os
import sys


REQUIRED_TABLES = {
    "tenant_settings": {"tenant_id", "display_name", "created_at", "updated_at"},
    "oauth_tokens": {
        "tenant_id",
        "provider",
        "access_token",
        "refresh_token_encrypted",
        "expires_at",
        "updated_at",
    },
    "conversation_logs": {
        "tenant_id",
        "session_id",
        "user_message",
        "response_payload",
        "why_fallback",
        "created_at",
    },
    "tool_call_logs": {
        "tenant_id",
        "session_id",
        "tool",
        "status",
        "latency_ms",
        "detail",
        "why_fallback",
        "created_at",
    },
    "rag_ingest_jobs": {
        "tenant_id",
        "version_tag",
        "source_paths",
        "upserted_chunks",
        "status",
        "why_fallback",
        "created_at",
    },
}

REQUIRED_INDEXES = {"idx_conversation_logs_fallback"}


def _fail(message: str) -> None:
    print(f"[schema-check] FAIL: {message}")
    raise SystemExit(1)


def main() -> None:
    database_url = os.getenv("SUPABASE_DB_URL", "").strip()
    if not database_url:
        _fail("SUPABASE_DB_URL is required (Postgres connection URL).")

    try:
        import psycopg
    except Exception as exc:  # pragma: no cover - runtime dependency check
        _fail(f"psycopg is required: {exc}")

    missing: list[str] = []

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                """
            )
            existing_tables = {row[0] for row in cur.fetchall()}

            for table_name, required_columns in REQUIRED_TABLES.items():
                if table_name not in existing_tables:
                    missing.append(f"table:{table_name}")
                    continue
                cur.execute(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = %s
                    """,
                    (table_name,),
                )
                existing_columns = {row[0] for row in cur.fetchall()}
                for column in required_columns:
                    if column not in existing_columns:
                        missing.append(f"column:{table_name}.{column}")

            cur.execute(
                """
                SELECT indexname
                FROM pg_indexes
                WHERE schemaname = 'public'
                """
            )
            existing_indexes = {row[0] for row in cur.fetchall()}
            for index_name in REQUIRED_INDEXES:
                if index_name not in existing_indexes:
                    missing.append(f"index:{index_name}")

    if missing:
        _fail(", ".join(sorted(missing)))

    print("[schema-check] OK: required tables, columns, and indexes are present.")


if __name__ == "__main__":
    main()

