from app.agents.langgraph.support_graph import map_tracking_progress


def test_tracking_progress_maps_stage_one() -> None:
    mapped = map_tracking_progress("주문접수")
    assert mapped is not None
    assert mapped["stage"] == 1
    assert mapped["label"] == "결제완료"


def test_tracking_progress_maps_stage_two() -> None:
    mapped = map_tracking_progress("배송중")
    assert mapped is not None
    assert mapped["stage"] == 2
    assert mapped["label"] == "배송중"


def test_tracking_progress_maps_stage_three() -> None:
    mapped = map_tracking_progress("배달완료")
    assert mapped is not None
    assert mapped["stage"] == 3
    assert mapped["label"] == "배송완료"


def test_tracking_progress_strict_mapping_unknown_status() -> None:
    mapped = map_tracking_progress("센터 분류 완료")
    assert mapped is not None
    assert mapped["stage"] is None
    assert mapped["label"] is None

