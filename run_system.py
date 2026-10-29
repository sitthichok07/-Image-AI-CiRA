"""
Main System Application & Web Server Launcher
FastAPI + Uvicorn + WebSockets + MJPEG Camera Streaming
บริษัท มูราตะ อิเล็กทรอนิกส์ (ประเทศไทย) จำกัด แผนก DX12
"""

import asyncio
import io
import time
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Dict, Any
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query, Body
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

import config
from backend import database as db
from backend.modbus_relay import relay_controller
from backend.camera_service import camera_service
from backend.controller import controller
from backend.mqtt_service import mqtt_service
from backend.supabase_service import supabase_service

@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    controller.set_event_loop(loop)
    print("=" * 65)
    print("  CiRA Image AI Workpiece Packing Inspection System")
    print("  บริษัท มูราตะ อิเล็กทรอนิกส์ (ประเทศไทย) จำกัด - DX12")
    print(f"  Web Dashboard: http://localhost:{config.PORT}")
    print("=" * 65)

    # Start clean without pre-filling mock lots
    controller.current_lot = None
    controller.registered_boxes = []
    controller.state = "AUTHENTICATION"
    controller.lot_number = db.get_next_lot_number()
    controller.dummy_good_passed = False
    controller.dummy_ng_passed = False
    camera_service.start_stream()
    yield
    camera_service.stop_stream()
    relay_controller.turn_all_off()

app = FastAPI(
    title="CiRA CORE Workpiece Packing Inspection System",
    description="ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA - Murata DX12",
    version="1.0.0",
    lifespan=lifespan
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Static & Data Directories
app.mount("/static", StaticFiles(directory=str(config.BASE_DIR / "frontend" / "static")), name="static")
app.mount("/inspections", StaticFiles(directory=str(config.INSPECTIONS_DIR)), name="inspections")


# ---------------- Web Pages & Video Stream ----------------

@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    index_file = config.BASE_DIR / "frontend" / "templates" / "index.html"
    return HTMLResponse(content=index_file.read_text(encoding="utf-8"))

def gen_video_frames():
    """MJPEG Video streaming generator."""
    while True:
        jpeg_bytes = camera_service.get_latest_jpeg()
        if jpeg_bytes:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + jpeg_bytes + b'\r\n')
        time.sleep(0.04)  # ~25 FPS

@app.get("/video_feed")
async def video_feed():
    """Live MJPEG video stream from camera or simulated inspection feed."""
    return StreamingResponse(
        gen_video_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

# ---------------- WebSockets Telemetry ----------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    controller.register_ws(websocket)
    # Send initial state
    await websocket.send_json(controller.get_telemetry())
    try:
        while True:
            # Keep alive and receive any client ping
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        controller.unregister_ws(websocket)
    except Exception:
        controller.unregister_ws(websocket)

# ---------------- REST API Routes ----------------

@app.post("/api/auth/login")
@app.post("/api/auth/pin")
async def api_auth_login(data: Dict[str, Any] = Body(...)):
    operator_id = str(data.get("operator_id", "")).strip() or config.DEFAULT_OPERATOR_ID
    operator_name = str(data.get("operator_name", "")).strip() or getattr(config, "DEFAULT_OPERATOR_NAME", "Aun")
    
    controller.operator_id = operator_id
    controller.operator_name = operator_name
    return {
        "success": True,
        "operator_id": operator_id,
        "operator_name": operator_name,
        "message": f"เข้าสู่ระบบสำเร็จในฐานะ {operator_id} ({operator_name})"
    }

@app.get("/api/operator/lookup")
async def api_operator_lookup(id: str = ""):
    clean_id = id.strip()
    name = db.lookup_operator_name(clean_id)
    return {"operator_id": clean_id, "operator_name": name}

@app.get("/api/lot/next-number")
async def api_next_lot_number():
    next_num = db.get_next_lot_number()
    return {"next_lot_number": next_num}

@app.get("/api/lot/carryover")
async def api_get_carryover():
    # Carryover is no longer passed to next lot per user requirement
    return {"has_carryover": False, "carryover": None}

@app.post("/api/lot/setup")
async def api_lot_setup(data: Dict[str, Any] = Body(...)):
    op_id = data.get("operator_id", controller.operator_id or config.DEFAULT_OPERATOR_ID)
    op_name = data.get("operator_name", getattr(controller, "operator_name", "SUTHEE RACHANAKUL"))
    res = await controller.initialize_lot(
        operator_id=op_id,
        operator_name=op_name,
        lot_number=data.get("lot_number", "LOT-01"),
        part_model=data.get("part_model", config.DEFAULT_PART_MODEL),
        total_boxes=int(data.get("total_boxes", 3)),
        qty_per_box=int(data.get("qty_per_box", 700)),
        inspection_no=data.get("inspection_no", "TEST21200"),
        table_no=data.get("table_no", "Offline07"),
        job_format=data.get("job_format", "กลาง"),
        total_work_qty=int(data.get("total_work_qty", 2000)),
        registered_boxes=data.get("registered_boxes", [])
    )
    return res

@app.post("/api/dummy/test")
async def api_dummy_test(data: Dict[str, Any] = Body(...)):
    sample_type = data.get("sample_type", "GOOD_SAMPLE")
    res = await controller.run_dummy_test(sample_type)
    return res

@app.post("/api/inspection/scan")
async def api_inspection_scan(data: Dict[str, Any] = Body(...)):
    barcode = data.get("barcode", "").strip()
    if not barcode:
        return JSONResponse(status_code=400, content={"error": "Empty barcode"})
    res = await controller.process_box_barcode(barcode)
    if isinstance(res, dict) and "error" in res:
        return JSONResponse(status_code=400, content=res)
    return res

@app.post("/api/inspection/trigger")
async def api_inspection_trigger(data: Dict[str, Any] = Body(...)):
    force_result = data.get("force_result")
    res = await controller.trigger_manual_inspection(force_result)
    if isinstance(res, dict) and "error" in res:
        return JSONResponse(status_code=400, content=res)
    return {"status": "TRIGGERED"}

@app.post("/api/bypass")
async def api_bypass(data: Dict[str, Any] = Body(...)):
    leader_id = data.get("leader_id", "")
    reason = data.get("reason", "Leader Verification")
    decision = data.get("decision", "G")
    res = await controller.authorize_leader_bypass(leader_id=leader_id, reason=reason, decision=decision)
    return res

@app.post("/api/alarm/clear")
async def api_alarm_clear():
    controller.clear_alarm()
    return {"status": "CLEARED"}

@app.post("/api/lot/pause")
async def api_lot_pause(data: Dict[str, Any] = Body(...)):
    lot_number = data.get("lot_number", getattr(controller, "lot_number", ""))
    defect_qty = data.get("defect_qty", 0)
    reject_qty = data.get("reject_qty", 0)
    registered_boxes = data.get("registered_boxes", [])
    res = await controller.pause_lot(lot_number=lot_number, defect_qty=defect_qty, reject_qty=reject_qty, registered_boxes=registered_boxes)
    return res

@app.get("/api/lot/check")
async def api_lot_check(lot_number: str = Query(...)):
    res = controller.check_and_resume_lot(lot_number)
    is_resumed = bool(res and res.get("is_resumed"))
    return {
        "success": True,
        "resumable": is_resumed,
        "is_resumed": is_resumed,
        "lot": res if is_resumed else None,
        **(res if isinstance(res, dict) else {})
    }

@app.post("/api/lot/close")
async def api_lot_close(data: Dict[str, Any] = Body(...)):
    close_type = data.get("close_type", "COMPLETED")
    res = await controller.close_lot(close_type)
    return res

@app.get("/api/lots")
async def api_get_lots():
    if getattr(config, "SUPABASE_ENABLED", False):
        supabase_lots = await supabase_service.get_lots()
        if supabase_lots is not None:
            return supabase_lots
    return db.get_all_lots()

@app.get("/api/inspections")
async def api_get_inspections(lot_filter: Optional[str] = Query(None)):
    if getattr(config, "SUPABASE_ENABLED", False):
        supabase_insp = await supabase_service.get_inspections(lot_filter=lot_filter)
        if supabase_insp is not None:
            return supabase_insp
    return db.get_all_inspections(limit=150, lot_filter=lot_filter)

# ---------------- Quality Analytics & Web Monitoring APIs ----------------

@app.get("/api/analytics/summary")
async def api_get_analytics_summary():
    """Computes overall KPIs: Total Boxes, Good %, Defect %, Yield Rate %, Avg Cycle Time."""
    return db.get_analytics_summary()

@app.get("/api/analytics/pareto")
async def api_get_analytics_pareto():
    """Calculates defect type distribution and cumulative percentage for Pareto Chart."""
    return db.get_defect_pareto()

@app.get("/api/analytics/hourly")
async def api_get_analytics_hourly():
    """Calculates production and defect rate trend grouped by hour."""
    return db.get_hourly_trend()

@app.get("/api/analytics/lots-comparison")
async def api_get_analytics_lots(limit: int = Query(10, ge=1, le=50)):
    """Returns lot-by-lot yield comparison."""
    return db.get_lots_comparison(limit=limit)

@app.get("/api/analytics/recent-defects")
async def api_get_recent_defects(limit: int = Query(10, ge=1, le=30)):
    """Returns recent NG defect incidents for the live feed."""
    return db.get_recent_defects(limit=limit)

@app.post("/api/cira/result")
async def api_cira_direct_webhook(payload: Dict[str, Any] = Body(...)):
    """Direct HTTP Webhook for CiRA CORE to post results."""
    await controller.evaluate_inspection_result(payload)
    return {"status": "PROCESSED"}

@app.post("/api/modbus/test")
async def api_modbus_test():
    """Sequentially tests all 4 relay channels."""
    def _run_test():
        for ch in [1, 2, 3, 4]:
            relay_controller.set_relay(ch, True)
            time.sleep(0.4)
            relay_controller.set_relay(ch, False)
            time.sleep(0.1)
        relay_controller.set_relay(config.RELAY_CH_YELLOW, True)
    threading.Thread(target=_run_test, daemon=True).start()
    return {"status": "TEST_TRIGGERED"}

@app.post("/api/modbus/test-channel")
async def api_modbus_test_channel(channel: int = Query(1)):
    """Temporarily pulses a single channel for 1.2s for testing."""
    def _pulse():
        relay_controller.set_relay(channel, True)
        time.sleep(1.2)
        relay_controller.set_relay(channel, False)
    threading.Thread(target=_pulse, daemon=True).start()
    return {"status": "PULSED", "channel": channel}
    
@app.get("/api/telemetry")
async def api_get_telemetry():
    """Fallback endpoint for real-time telemetry."""
    return controller.get_telemetry()


# ----------------- Collaborative Multi-Station APIs -----------------

@app.get("/api/lots/active")
async def api_get_active_lots():
    """Returns all active / in-progress lots available for multi-station collaborative packing."""
    active = db.get_active_lots()
    return active

@app.post("/api/lot/join")
async def api_lot_join(data: Dict[str, Any] = Body(...)):
    """Enables another workstation / operator to join an existing active lot."""
    lot_number = str(data.get("lot_number", "")).strip()
    operator_id = str(data.get("operator_id", "")).strip() or controller.operator_id
    operator_name = str(data.get("operator_name", "")).strip() or getattr(controller, "operator_name", "")
    table_no = str(data.get("table_no", "")).strip() or getattr(controller, "table_no", "Offline07")
    
    if not lot_number:
        return JSONResponse(status_code=400, content={"error": "Missing lot_number"})
        
    res = controller.check_and_resume_lot(
        lot_number=lot_number,
        operator_id=operator_id,
        operator_name=operator_name,
        table_no=table_no
    )
    return res

@app.get("/api/lot/sync")
async def api_lot_sync(lot_number: str = Query(...)):
    """Fetches live synchronized status and all inspections across stations for this lot."""
    data = db.get_lot_full_sync(lot_number.strip())
    return data

@app.get("/api/station/info")
async def api_get_station_info():
    return {
        "table_no": getattr(controller, "table_no", "Offline07"),
        "operator_id": controller.operator_id or "MTL80343",
        "operator_name": getattr(controller, "operator_name", "Aun")
    }

@app.post("/api/station/info")
async def api_set_station_info(data: Dict[str, Any] = Body(...)):
    if "table_no" in data and data["table_no"]:
        controller.table_no = str(data["table_no"]).strip()
    if "operator_id" in data and data["operator_id"]:
        controller.operator_id = str(data["operator_id"]).strip()
        controller.operator_name = db.lookup_operator_name(controller.operator_id) or data.get("operator_name", "")
    return {
        "table_no": controller.table_no,
        "operator_id": controller.operator_id,
        "operator_name": controller.operator_name
    }

def main():
    uvicorn.run("run_system:app", host=config.HOST, port=config.PORT, reload=False, ws="wsproto")

if __name__ == "__main__":
    main()



# ---------------- Supabase Cloud Integration APIs ----------------

@app.get("/api/supabase/status")
async def api_supabase_status():
    return await supabase_service.check_health()

@app.post("/api/supabase/sync-all")
async def api_supabase_sync_all():
    return await supabase_service.sync_all_from_local(db)

@app.get("/api/supabase/legacy-history")
async def api_supabase_legacy_history(lot_filter: Optional[str] = Query(None), limit: int = Query(200)):
    return await supabase_service.get_legacy_history(lot_filter=lot_filter, limit=limit)

@app.get("/api/supabase/config")
async def api_supabase_config():
    return {
        "enabled": getattr(config, "SUPABASE_ENABLED", True),
        "url": config.SUPABASE_URL,
        "anon_key": config.SUPABASE_PUBLISHABLE_KEY,
        "bucket": config.SUPABASE_BUCKET_NAME
    }

@app.post("/api/database/clear-all")
async def api_clear_all_data():
    """Wipes all local SQLite and Supabase production data for a fresh start."""
    db.clear_all_production_data()
    sb_res = await supabase_service.clear_all_supabase_data()
    controller.current_lot = None
    controller.registered_boxes = []
    controller.lot_number = "LOT-" + datetime.now().strftime("%Y%m%d-01")
    controller.part_model = config.DEFAULT_PART_MODEL
    controller.total_target_boxes = 3
    controller.qty_per_box = 700
    controller.state = "AUTHENTICATION"
    controller.dummy_good_passed = False
    controller.dummy_ng_passed = False
    controller.broadcast_state()
    return {"success": True, "message": "ล้างข้อมูลประวัติและล็อตทั้งหมดเรียบร้อยแล้ว", "supabase": sb_res}
