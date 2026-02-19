from typing import Any

from app.core.config import get_settings


def _heuristic_review(answer: str, sources: list[dict], intent: str) -> dict[str, Any]:
    needs_fix = False
    reason = ""
    if intent == "policy" and "확인 불가" not in answer and not sources:
        needs_fix = True
        reason = "No sources attached to policy answer."
    if not answer.strip():
        needs_fix = True
        reason = "Empty answer."
    return {"approved": not needs_fix, "reason": reason}


def review_response(
    *,
    question: str,
    answer: str,
    intent: str,
    sources: list[dict],
) -> dict[str, Any]:
    """
    CrewAI 검수 워커 진입점.
    CrewAI가 설치/설정되지 않아도 서비스가 중단되지 않도록 휴리스틱 검수로 폴백한다.
    """
    settings = get_settings()
    if not settings.crewai_review_enabled:
        return _heuristic_review(answer, sources, intent)

    try:
        from crewai import Agent, Crew, Process, Task
    except Exception:
        return _heuristic_review(answer, sources, intent)

    if not settings.openai_api_key:
        return _heuristic_review(answer, sources, intent)

    reviewer = Agent(
        role="CS Quality Supervisor",
        goal="정책 위반/근거 부족 답변을 사전에 차단한다.",
        backstory="이커머스 고객 상담 품질 검수 에이전트",
        verbose=False,
        allow_delegation=False,
    )
    task = Task(
        description=(
            "아래 응답을 검수하고 APPROVED=YES/NO와 REASON을 반환해라.\n"
            f"QUESTION: {question}\nINTENT: {intent}\nANSWER: {answer}\nSOURCES: {sources}"
        ),
        expected_output="APPROVED=YES|NO;REASON=<short>",
        agent=reviewer,
    )
    try:
        crew = Crew(agents=[reviewer], tasks=[task], process=Process.sequential, verbose=False)
        result = str(crew.kickoff())
        result_upper = result.upper()
        approved = "APPROVED=YES" in result_upper
        reason = result.split("REASON=")[-1].strip() if "REASON=" in result else ""
        return {"approved": approved, "reason": reason}
    except Exception:
        return _heuristic_review(answer, sources, intent)
