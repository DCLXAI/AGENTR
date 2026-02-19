import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.integrations.shipping.client import ShippingAPIError, ShippingClient


router = APIRouter(prefix="/v1/tools", tags=["tools"])


class TrackDeliveryRequest(BaseModel):
    courier_code: str = Field(min_length=1)
    tracking_number: str = Field(min_length=10)


class TrackDeliveryResponse(BaseModel):
    status: str
    last_detail: str
    latency_ms: int


@router.post("/track-delivery", response_model=TrackDeliveryResponse)
def track_delivery(payload: TrackDeliveryRequest) -> TrackDeliveryResponse:
    client = ShippingClient()
    started = time.perf_counter()
    try:
        result = client.track_delivery(
            courier_code=payload.courier_code,
            tracking_number=payload.tracking_number,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ShippingAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    latency_ms = int((time.perf_counter() - started) * 1000)
    return TrackDeliveryResponse(
        status=result.status,
        last_detail=result.last_detail,
        latency_ms=latency_ms,
    )

