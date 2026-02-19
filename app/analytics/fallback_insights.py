import argparse
from collections import Counter, defaultdict

from app.repositories.supabase_repo import get_supabase_repo


def build_fallback_insights(limit: int = 5, sample_per_reason: int = 5) -> str:
    repo = get_supabase_repo()
    if not repo.enabled:
        raise ValueError("Supabase is not configured.")

    response = (
        repo._client.table("conversation_logs")
        .select("why_fallback,user_message,created_at")
        .order("created_at", desc=True)
        .limit(1000)
        .execute()
    )
    rows = response.data or []
    if not rows:
        return "No fallback logs found."

    counts = Counter(row["why_fallback"] for row in rows if row.get("why_fallback"))
    samples: dict[str, list[str]] = defaultdict(list)

    for row in rows:
        reason = row.get("why_fallback")
        question = (row.get("user_message") or "").strip()
        if not reason or not question:
            continue
        if len(samples[reason]) >= sample_per_reason:
            continue
        if question in samples[reason]:
            continue
        samples[reason].append(question)

    lines = ["# Fallback Insights", ""]
    for reason, count in counts.most_common(limit):
        lines.append(f"## {reason} ({count})")
        for question in samples.get(reason, []):
            lines.append(f"- {question}")
        lines.append("")
    return "\n".join(lines).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build fallback insight report from Supabase logs.")
    parser.add_argument("--limit", type=int, default=5, help="Number of fallback reasons to include.")
    parser.add_argument("--samples", type=int, default=5, help="Sample questions per fallback reason.")
    args = parser.parse_args()
    print(build_fallback_insights(limit=args.limit, sample_per_reason=args.samples))


if __name__ == "__main__":
    main()
