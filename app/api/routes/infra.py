from concurrent.futures import ThreadPoolExecutor, wait

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import get_settings


router = APIRouter(tags=["infra"])

READINESS_TIMEOUT_SECONDS = 2.0


class ReadyChecks(BaseModel):
    env: str
    supabase: str
    pinecone: str
    deliveryapi_config: str


class ReadyDetails(BaseModel):
    failed: list[str]


class ReadyResponse(BaseModel):
    status: str
    checks: ReadyChecks
    details: ReadyDetails


def _run_dependency_checks(timeout: float) -> dict[str, tuple[bool, str]]:
    if timeout <= 0:
        return {"supabase": (False, "timeout"), "pinecone": (False, "timeout")}

    checks = {
        "supabase": _check_supabase,
        "pinecone": _check_pinecone,
    }
    results: dict[str, tuple[bool, str]] = {}

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {name: executor.submit(func) for name, func in checks.items()}
        done, not_done = wait(set(futures.values()), timeout=timeout)

        for name, future in futures.items():
            if future in not_done:
                results[name] = (False, "timeout")
                future.cancel()
                continue
            try:
                future.result()
                results[name] = (True, "")
            except Exception as exc:  # pragma: no cover - defensive
                results[name] = (False, str(exc))

    return results


def _check_supabase() -> None:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise ValueError("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing")
    try:
        from supabase import create_client
    except Exception as exc:
        raise RuntimeError("supabase client import failed") from exc

    client = create_client(settings.supabase_url, settings.supabase_service_role_key)
    # Real connectivity check: lightweight select query.
    client.table("tenant_settings").select("tenant_id").limit(1).execute()


def _check_pinecone() -> None:
    settings = get_settings()
    if not settings.pinecone_api_key:
        raise ValueError("PINECONE_API_KEY missing")
    if not settings.pinecone_index:
        raise ValueError("PINECONE_INDEX missing")
    from pinecone import Pinecone

    pc = Pinecone(api_key=settings.pinecone_api_key)
    if settings.pinecone_index_host:
        index = pc.Index(host=settings.pinecone_index_host)
        index.describe_index_stats()
    else:
        pc.describe_index(settings.pinecone_index)


@router.get("/ready", response_model=ReadyResponse)
def ready() -> ReadyResponse:
    settings = get_settings()
    failed: list[str] = []

    checks = ReadyChecks(
        env="ok",
        supabase="fail",
        pinecone="fail",
        deliveryapi_config="ok",
    )

    missing_env = settings.missing_required_env_for_api()
    if missing_env:
        checks.env = "fail"
        failed.extend([f"env:{name}" for name in missing_env])

    if not (settings.sweettracker_api_key or settings.deliveryapi_key):
        checks.deliveryapi_config = "fail"
        failed.append("deliveryapi_config")

    dep_results = _run_dependency_checks(READINESS_TIMEOUT_SECONDS)
    ok_supabase, err_supabase = dep_results["supabase"]
    if ok_supabase:
        checks.supabase = "ok"
    else:
        checks.supabase = "fail"
        failed.append(f"supabase:{err_supabase or 'unknown'}")

    ok_pinecone, err_pinecone = dep_results["pinecone"]
    if ok_pinecone:
        checks.pinecone = "ok"
    else:
        checks.pinecone = "fail"
        failed.append(f"pinecone:{err_pinecone or 'unknown'}")

    if checks.env == "fail":
        status = "fail"
    elif checks.supabase == "ok" and checks.pinecone == "ok" and checks.deliveryapi_config == "ok":
        status = "ok"
    elif checks.supabase == "fail" and checks.pinecone == "fail":
        status = "fail"
    else:
        status = "degraded"

    return ReadyResponse(status=status, checks=checks, details=ReadyDetails(failed=failed))
