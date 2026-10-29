"""
Central Inspection Controller & State Machine
Coordinates Operator Authentication, Dummy Test, Poka-Yoke 2s Delay,
AI Result Evaluation (G/NG), Modbus Relay Alarms, Leader Bypass, and WebSockets
"""

import asyncio
import base64
import time
import uuid
from datetime import datetime
import math
from typing import Dict, Any, List, Optional
import config
from backend import database as db
from backend.modbus_relay import relay_controller
from backend.cira_simulator import cira_sim
from backend.camera_service import camera_service
from backend.mqtt_service import mqtt_service
from backend.supabase_service import supabase_service


class InspectionController:
    def __init__(self):
        # Current active state
        self.state = "AUTHENTICATION"  # AUTHENTICATION, DUMMY_TEST, READY, DELAY_MOTION, INSPECTING, ALARM_NG, LOT_CLOSED
        self.current_lot: Optional[Dict[str, Any]] = None
        self.operator_id = config.DEFAULT_OPERATOR_ID
        self.operator_name = getattr(config, "DEFAULT_OPERATOR_NAME", "Aun")
        self.lot_number = "LOT-" + datetime.now().strftime("%Y%m%d-01")
        self.part_model = config.DEFAULT_PART_MODEL
        self.total_target_boxes = getattr(config, "DEFAULT_TARGET_BOXES", 3)
        self.qty_per_box = getattr(config, "DEFAULT_QTY_PER_BOX", 700)
        self.operator_name = getattr(config, "DEFAULT_OPERATOR_NAME", "SUTHEE RACHANAKUL")
        self.inspection_no = "TEST21200"
        self.table_no = "Offline07"
        self.job_format = "กลาง"
        self.total_work_qty = 2000
        self.registered_boxes: List[Dict[str, Any]] = []
        self.current_box_barcode = ""
        self.dummy_good_passed = False
        self.dummy_ng_passed = False

        # Last inspection result
        self.last_inspection: Optional[Dict[str, Any]] = None
        self.active_alarm = False
        self.delay_remaining_sec = 0.0

        # Connected WebSocket clients
        self.ws_clients: List[Any] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # Wire up relay callbacks to notify Web clients
        relay_controller.register_callback(self._on_relay_change)

        # Wire up MQTT listener for CiRA results
        mqtt_service.subscribe(config.TOPIC_INSPECTION_RESULT, self._on_cira_result_received)
        mqtt_service.subscribe(config.TOPIC_BARCODE, self._on_barcode_scanned)

    def set_event_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def _on_relay_change(self, relay_states: Dict[int, bool]):
        self.broadcast_state()

    def _on_barcode_scanned(self, data: Dict[str, Any]):
        barcode = data.get("barcode") or data.get("raw") or ""
        if barcode:
            asyncio.run_coroutine_threadsafe(self.process_box_barcode(str(barcode).strip()), self._loop)

    def _on_cira_result_received(self, data: Dict[str, Any]):
        """Callback when CiRA CORE publishes inspection payload."""
        asyncio.run_coroutine_threadsafe(self.evaluate_inspection_result(data), self._loop)

    def register_ws(self, ws: Any):
        if ws not in self.ws_clients:
            self.ws_clients.append(ws)

    def unregister_ws(self, ws: Any):
        if ws in self.ws_clients:
            self.ws_clients.remove(ws)

    def broadcast_state(self):
        """Broadcasts full system telemetry to all connected web clients."""
        if not self._loop or not self.ws_clients:
            return

        payload = self.get_telemetry()
        for ws in list(self.ws_clients):
            try:
                asyncio.run_coroutine_threadsafe(ws.send_json(payload), self._loop)
            except Exception:
                pass

    def get_telemetry(self) -> Dict[str, Any]:
        """Returns snapshot of current system status."""
        if self.state == "LOT_CLOSED":
            lot_summary = {
                "inspections_total": 0,
                "good_boxes": 0,
                "ng_boxes": 0,
                "bypassed_boxes": 0,
                "inspections": []
            }
        else:
            lot_summary = db.get_lot_summary(self.lot_number) if self.current_lot else {}

        total_done = (lot_summary.get("inspections_total", 0) if (lot_summary and self.state != "LOT_CLOSED") else 0)
        output_qty = (lot_summary.get("output_qty", 0) if (lot_summary and self.state != "LOT_CLOSED") else 0)
        total_work_qty = getattr(self, "total_work_qty", 2000) or 2000
        work_remaining_qty = max(0, total_work_qty - output_qty)
        reg_boxes = getattr(self, "registered_boxes", [])

        # Check if more boxes must be scanned (all pre-registered boxes scanned, but work still incomplete)
        need_more_boxes = bool(
            self.state == "READY"
            and total_done >= len(reg_boxes)
            and work_remaining_qty > 0
            and (self.dummy_good_passed and self.dummy_ng_passed)
        )

        next_box_barcode = ""
        current_box_index = total_done + 1
        if reg_boxes and total_done < len(reg_boxes):
            next_box_barcode = reg_boxes[total_done].get("box_no", "")

        return {
            "type": "STATE_UPDATE",
            "state": self.state,
            "operator_id": self.operator_id,
            "operator_name": getattr(self, "operator_name", "SUTHEE RACHANAKUL"),
            "inspection_no": getattr(self, "inspection_no", "TEST21200"),
            "table_no": getattr(self, "table_no", "Offline07"),
            "job_format": getattr(self, "job_format", "กลาง"),
            "total_work_qty": getattr(self, "total_work_qty", 2000),
            "output_qty": output_qty,
            "work_remaining_qty": work_remaining_qty,
            "need_more_boxes": need_more_boxes,
            "registered_boxes": reg_boxes,
            "next_box_barcode": next_box_barcode,
            "current_box_index": current_box_index,
            "lot_number": self.lot_number,
            "part_model": self.part_model,
            "total_target_boxes": self.total_target_boxes,
            "qty_per_box": self.qty_per_box,
            "current_box_barcode": self.current_box_barcode,
            "dummy_tested": bool(self.dummy_good_passed and self.dummy_ng_passed),
            "dummy_status": {
                "good_passed": self.dummy_good_passed,
                "ng_passed": self.dummy_ng_passed
            },
            "active_alarm": self.active_alarm,
            "delay_remaining_sec": self.delay_remaining_sec,
            "relays": relay_controller.get_status()["relays"],
            "last_inspection": self.last_inspection,
            "evaluating_result": getattr(self, "evaluating_result", None),
            "lot_summary": lot_summary,
            "pending_carryover": db.get_pending_carryover(),
            "simulation_mode": config.SIMULATION_MODE,
            "timestamp": datetime.now().isoformat()
        }

    # ---------------- Workflow Actions ----------------

    async def initialize_lot(
        self,
        operator_id: str,
        lot_number: str,
        part_model: str,
        total_boxes: int = 3,
        qty_per_box: int = 700,
        operator_name: Optional[str] = None,
        inspection_no: str = "TEST21200",
        table_no: str = "Offline07",
        job_format: str = "กลาง",
        total_work_qty: int = 2000,
        registered_boxes: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        self.operator_id = operator_id.strip()
        if operator_name:
            self.operator_name = operator_name.strip()
        else:
            self.operator_name = db.lookup_operator_name(self.operator_id) or "SUTHEE RACHANAKUL"
        self.lot_number = lot_number.strip()
        self.part_model = part_model.strip()
        self.registered_boxes = list(registered_boxes or [])
        self.qty_per_box = int(qty_per_box or 700)
        self.inspection_no = inspection_no.strip()
        self.table_no = table_no.strip()
        self.job_format = job_format.strip()
        self.total_work_qty = int(total_work_qty or 2000)

        # Standard planned boxes to pack total_work_qty (e.g. 2000 / 700 = 3 boxes)
        planned_boxes = math.ceil(self.total_work_qty / self.qty_per_box) if self.qty_per_box > 0 else 1
        # Set total target boxes according to registered boxes or planned boxes
        self.total_target_boxes = max(len(self.registered_boxes), int(total_boxes or planned_boxes), 1)

        # Consume any pending carryover for this new lot
        pending = db.get_pending_carryover()
        if pending:
            db.consume_carryover(pending["id"], self.lot_number)

        # Clear any leftover alarms and inspection state
        self.current_box_barcode = ""
        self.last_inspection = None
        self.active_alarm = False
        self.delay_remaining_sec = 0.0
        camera_service.clear_alarm_frame()

        # Create or fetch lot in database (force reset if lot was closed)
        self.current_lot = db.create_or_get_lot(
            lot_number=self.lot_number,
            operator_id=self.operator_id,
            part_model=self.part_model,
            total_target_boxes=self.total_target_boxes,
            qty_per_box=self.qty_per_box,
            force_reset_if_closed=True,
            operator_name=self.operator_name,
            inspection_no=self.inspection_no,
            table_no=self.table_no,
            job_format=self.job_format,
            total_work_qty=self.total_work_qty
        )

        lot_summary = db.get_lot_summary(self.lot_number) if self.current_lot else {}
        total_done = lot_summary.get("inspections_total", 0)

        # Check if this lot has already passed dummy test
        already_dummy_tested = bool(self.current_lot and self.current_lot.get("dummy_tested")) or bool(self.dummy_good_passed and self.dummy_ng_passed) or (total_done > 0)

        if self.total_target_boxes > 0 and total_done >= self.total_target_boxes:
            self.state = "LOT_COMPLETE"
        elif already_dummy_tested:
            # Preserve dummy tested status if this lot has already passed it!
            self.dummy_good_passed = True
            self.dummy_ng_passed = True
            self.state = "READY"
            relay_controller.trigger_standby()
        else:
            # Poka-Yoke: MUST pass Dummy Test first (NG then Good)!
            self.dummy_good_passed = False
            self.dummy_ng_passed = False
            self.state = "DUMMY_TEST"
            relay_controller.set_relay(config.RELAY_CH_YELLOW, True)

        # Asynchronously sync lot to Supabase Cloud in background
        if self.current_lot:
            asyncio.create_task(supabase_service.sync_lot(self.current_lot))
        else:
            asyncio.create_task(supabase_service.sync_lot({
                "lot_number": self.lot_number,
                "operator_id": self.operator_id,
                "part_model": self.part_model,
                "inspection_no": self.inspection_no,
                "table_no": self.table_no,
                "job_format": self.job_format,
                "total_work_qty": self.total_work_qty,
                "qty_per_box": self.qty_per_box,
                "status": "In Progress",
                "dummy_tested": already_dummy_tested
            }))

        self.broadcast_state()
        return self.get_telemetry()

    async def run_dummy_test(self, sample_type: str = "GOOD_SAMPLE") -> Dict[str, Any]:
        """Runs a Poka-Yoke Dummy verification test (enforcing NG first, then Good)."""
        if self.state == "ALARM_NG":
            return {
                "error": "⛔ งานไม่ผ่าน (NG): ระบบล็อกการทำงาน ต้องให้ LEADER อนุมัติข้ามก่อนเท่านั้น!"
            }

        # Poka-Yoke rule: Must test NG sample first!
        if sample_type == "GOOD_SAMPLE" and not self.dummy_ng_passed:
            return {
                "error": "⚠️ ลำดับการทดสอบ: ต้องทดสอบชิ้นงานตัวอย่าง NG ให้ผ่านก่อนทดสอบ Good!"
            }

        is_good = (sample_type == "GOOD_SAMPLE")
        sim_res = cira_sim.inspect_sample(
            box_barcode=f"DUMMY-{sample_type}",
            force_result="G" if is_good else "NG"
        )

        db.record_dummy_test(
            lot_number=self.lot_number,
            operator_id=self.operator_id,
            sample_type=sample_type,
            result="PASS",
            confidence_score=sim_res["confidence"]
        )

        if is_good:
            self.dummy_good_passed = True
            camera_service.clear_alarm_frame()
            if sim_res.get("image_base64"):
                camera_service.update_from_cira_base64(sim_res["image_base64"], is_ng=False)
        else:
            self.dummy_ng_passed = True
            if sim_res.get("image_base64"):
                camera_service.freeze_alarm_frame(jpeg_bytes=base64.b64decode(sim_res["image_base64"]))
            else:
                camera_service.freeze_alarm_frame()

        if self.dummy_good_passed and self.dummy_ng_passed:
            db.set_lot_dummy_tested(self.lot_number, True)
            self.state = "READY"
            relay_controller.trigger_standby()

        self.last_inspection = {
            "box_barcode": f"DUMMY-{sample_type}",
            "result": "G" if is_good else "NG",
            "confidence": sim_res["confidence"],
            "image_base64": sim_res["image_base64"],
            "is_dummy": True
        }

        # Asynchronously sync dummy test to Supabase Cloud
        asyncio.create_task(supabase_service.sync_dummy_test(
            lot_number=self.lot_number,
            operator_id=self.operator_id or "MTL80343",
            sample_type=sample_type,
            actual_result="G" if is_good else "NG",
            passed=bool(is_good if sample_type == "GOOD_SAMPLE" else not is_good)
        ))

        self.broadcast_state()
        return self.get_telemetry()

    async def process_box_barcode(self, barcode: str) -> Dict[str, Any]:
        """Triggered when barcode scanner reads a packaging box."""
        lot_summary = db.get_lot_summary(self.lot_number) if self.current_lot else {}
        total_done = lot_summary.get("inspections_total", 0)
        target = self.total_target_boxes

        if self.state in ["LOT_COMPLETE", "LOT_CLOSED"] or (target > 0 and total_done >= target):
            self.state = "LOT_COMPLETE"
            self.broadcast_state()
            return {
                "error": f"⛔ ล็อตนี้ตรวจครบตามเป้าหมายแล้ว ({total_done}/{target} กล่อง) ระบบบล็อกการตรวจจับ บังคับปิดล็อตการผลิตเท่านั้น!"
            }

        if self.state == "ALARM_NG":
            return {
                "error": "⛔ งานไม่ผ่าน (NG): ระบบล็อกการทำงาน ต้องให้ LEADER อนุมัติข้ามก่อนเท่านั้น!"
            }
        if self.state == "DUMMY_TEST":
            lot_summary = db.get_lot_summary(self.lot_number) if self.current_lot else {}
            has_done = (lot_summary.get("inspections_total", 0) > 0)
            if has_done or (self.dummy_good_passed and self.dummy_ng_passed) or (self.current_lot and self.current_lot.get("dummy_tested")):
                self.dummy_good_passed = True
                self.dummy_ng_passed = True
                self.state = "READY"
            elif getattr(config, "DUMMY_SAMPLE_REQUIRED", False):
                return {
                    "error": "Poka-Yoke Lock: บังคับทดสอบชิ้นงานตัวอย่าง (Dummy Test) ทั้ง Good และ NG ให้ผ่านครบก่อนเริ่มสแกนกล่องงานจริง!"
                }
            else:
                self.state = "READY"
        if self.state in ["DELAY_MOTION", "INSPECTING", "RESULT_HOLD"]:
            return {"error": "ระบบกำลังประมวลผลการตรวจสอบ กรุณารอสักครู่"}
        if self.state != "READY":
            return {"error": f"ไม่สามารถสแกนกล่องได้ในสถานะ {self.state}"}

        barcode = (barcode or "").strip()
        reg_boxes = getattr(self, "registered_boxes", [])

        if barcode:
            known_box = next((b for b in reg_boxes if b.get("box_no", "").strip().upper() == barcode.upper()), None)
            if not known_box:
                new_box_entry = {
                    "ins_no": len(reg_boxes) + 1,
                    "box_no": barcode,
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "operator": getattr(self, "operator_name", "SUTHEE RACHANAKUL"),
                    "is_carryover": False,
                    "leftover_qty": None
                }
                reg_boxes.append(new_box_entry)
                self.registered_boxes = reg_boxes
                if self.total_target_boxes < len(reg_boxes):
                    self.total_target_boxes = len(reg_boxes)
        else:
            if reg_boxes and total_done < len(reg_boxes):
                barcode = reg_boxes[total_done].get("box_no", "")
            else:
                rem = max(0, getattr(self, "total_work_qty", 2000) - lot_summary.get("output_qty", 0))
                return {
                    "error": f"⚠️ กล่องที่ลงทะเบียนไว้ตรวจครบแล้ว (ยังขาดอีก {rem} ชิ้น) กรุณาสแกนบาร์โค้ดกล่องใหม่เพื่อตรวจต่อ!"
                }

        self.current_box_barcode = barcode
        self.state = "DELAY_MOTION"
        self.broadcast_state()

        # Step 7: Poka-Yoke Delay (2.0s) to prevent motion blur
        steps = 20
        step_duration = config.MOTION_BLUR_DELAY_SEC / steps
        for i in range(steps, 0, -1):
            self.delay_remaining_sec = round(i * step_duration, 1)
            self.broadcast_state()
            await asyncio.sleep(step_duration)

        self.delay_remaining_sec = 0.0
        self.state = "INSPECTING"
        self.broadcast_state()

        # Trigger CiRA CORE via MQTT
        mqtt_service.trigger_cira_camera(barcode)

        # In simulation mode, generate AI inspection automatically
        if config.SIMULATION_MODE:
            await self._run_simulated_ai_inspection(barcode)

        return self.get_telemetry()

    async def _run_simulated_ai_inspection(self, barcode: str):
        """Simulates CiRA CORE AI processing."""
        await asyncio.sleep(0.3)  # inference time simulation
        force = "NG" if "NG" in (barcode or "").upper() else "RANDOM"
        sim_data = cira_sim.inspect_sample(box_barcode=barcode, force_result=force)
        await self.evaluate_inspection_result(sim_data)

    async def trigger_manual_inspection(self, force_result: Optional[str] = None):
        """Manual trigger button from Web Dashboard."""
        lot_summary = db.get_lot_summary(self.lot_number) if self.current_lot else {}
        total_done = lot_summary.get("inspections_total", 0)
        target = self.total_target_boxes
        output_qty = lot_summary.get("output_qty", 0)
        total_work_qty = getattr(self, "total_work_qty", 2000) or 2000

        if self.state in ["LOT_COMPLETE", "LOT_CLOSED"] or (output_qty >= total_work_qty and total_work_qty > 0):
            self.state = "LOT_COMPLETE"
            self.broadcast_state()
            return {
                "error": f"⛔ ล็อตนี้ตรวจครบตามเป้าหมายแล้ว ({output_qty}/{total_work_qty} ชิ้น) ระบบบล็อกการตรวจจับ บังคับปิดล็อตการผลิตเท่านั้น!"
            }

        if self.state == "ALARM_NG":
            return {
                "error": "⛔ งานไม่ผ่าน (NG): ระบบล็อกการทำงาน ต้องให้ LEADER อนุมัติข้ามก่อนเท่านั้น!"
            }
        if self.state == "DUMMY_TEST":
            has_done = (total_done > 0)
            if has_done or (self.dummy_good_passed and self.dummy_ng_passed) or (self.current_lot and self.current_lot.get("dummy_tested")):
                self.dummy_good_passed = True
                self.dummy_ng_passed = True
                self.state = "READY"
            elif getattr(config, "DUMMY_SAMPLE_REQUIRED", False):
                return {
                    "error": "Poka-Yoke Lock: บังคับทดสอบชิ้นงานตัวอย่าง (Dummy Test) ทั้ง Good และ NG ให้ผ่านครบก่อนเริ่มตรวจสอบ!"
                }
            else:
                self.state = "READY"
        if self.state in ["DELAY_MOTION", "INSPECTING", "RESULT_HOLD"]:
            return {"error": "ระบบกำลังประมวลผลการตรวจสอบ กรุณารอสักครู่"}
        if self.state != "READY":
            return {"error": f"ไม่สามารถตรวจสอบได้ในสถานะ {self.state}"}

        barcode = (self.current_box_barcode or "").strip()
        reg_boxes = getattr(self, "registered_boxes", [])
        if not barcode:
            if reg_boxes and total_done < len(reg_boxes):
                barcode = reg_boxes[total_done].get("box_no", "")
            else:
                rem = max(0, total_work_qty - output_qty)
                return {
                    "error": f"⚠️ กล่องที่ลงทะเบียนไว้ตรวจครบแล้ว (ยังขาดอีก {rem} ชิ้น) บังคับสแกนบาร์โค้ดกล่องใหม่เพื่อตรวจต่อ!"
                }
        self.current_box_barcode = barcode

        self.state = "DELAY_MOTION"
        self.broadcast_state()

        # 2s Poka-Yoke delay
        steps = 10
        step_duration = config.MOTION_BLUR_DELAY_SEC / steps
        for i in range(steps, 0, -1):
            self.delay_remaining_sec = round(i * step_duration, 1)
            self.broadcast_state()
            await asyncio.sleep(step_duration)

        self.delay_remaining_sec = 0.0
        self.state = "INSPECTING"
        self.broadcast_state()

        sim_data = cira_sim.inspect_sample(box_barcode=barcode, force_result=force_result or "RANDOM")
        await self.evaluate_inspection_result(sim_data)
        return self.get_telemetry()

    async def evaluate_inspection_result(self, cira_payload: Dict[str, Any]):
        """
        Evaluates CiRA CORE detection result (G or NG).
        Sequence:
        1. Show AI detection immediately on camera feed.
        2. Hold/Delay for 3.0s showing G/NG result and Tower Lamp before saving.
        3. Save inspection image and write record to database.
        4. Transition to READY/LOT_COMPLETE (for G) or ALARM_NG lock (for NG).
        """
        ai_result = cira_payload.get("result", "G").upper()
        confidence = float(cira_payload.get("confidence", 99.0))
        base64_str = cira_payload.get("image_base64", "")
        box_barcode = cira_payload.get("box_barcode", self.current_box_barcode or "UNKNOWN-BOX")
        defect_type = cira_payload.get("defect_type", "NONE" if ai_result == "G" else "TAPE_COVERED")
        cycle_time_ms = int(cira_payload.get("cycle_time_ms", 2350))

        self.evaluating_result = ai_result

        # 1. Save inspection photo & record to database immediately so UI has complete record during hold
        img_filename = f"{self.lot_number}_{box_barcode}_{int(time.time())}.jpg"
        img_path = None
        if base64_str:
            try:
                saved_file = cira_sim.decode_and_save_image(base64_str, img_filename)
                img_path = f"/inspections/{saved_file.name}"
            except Exception as e:
                print(f"Error saving inspection image: {e}")

        # Get current box index
        lot_summary = db.get_lot_summary(self.lot_number) if self.current_lot else {}
        box_index = (lot_summary.get("inspections_total", 0) or 0) + 1

        rec = db.record_inspection(
            lot_number=self.lot_number,
            box_barcode=box_barcode,
            box_index=box_index,
            operator_id=self.operator_id or "MTL80343",
            part_model=self.part_model or "E2E35A222MA387012F+M01/B",
            ai_result=ai_result,
            final_result=ai_result,
            confidence_score=confidence,
            image_path=img_path,
            table_no=getattr(self, "table_no", "Offline07"),
            operator_name=getattr(self, "operator_name", "")
        )

        # Asynchronously sync inspection & upload image to Supabase Cloud in background
        img_bytes_for_cloud = None
        if base64_str:
            try:
                img_bytes_for_cloud = base64.b64decode(base64_str)
            except Exception:
                img_bytes_for_cloud = None

        asyncio.create_task(supabase_service.sync_box_inspection(
            lot_number=self.lot_number,
            box_barcode=box_barcode,
            box_index=box_index,
            operator_id=self.operator_id or "MTL80343",
            ai_result=ai_result,
            final_result=ai_result,
            confidence_score=confidence,
            cycle_time_ms=cycle_time_ms,
            defect_type=defect_type,
            image_bytes=img_bytes_for_cloud
        ))
        if self.current_lot:
            asyncio.create_task(supabase_service.sync_lot(self.current_lot))

        self.last_inspection = {
            "id": rec["id"],
            "box_barcode": box_barcode,
            "box_index": box_index,
            "result": ai_result,
            "confidence": confidence,
            "image_path": img_path,
            "image_base64": base64_str,
            "timestamp": rec["created_at"],
            "is_bypassed": False
        }

        # 2. Update live camera stream with AI detection result immediately
        if base64_str:
            camera_service.update_from_cira_base64(base64_str, is_ng=(ai_result != "G"))

        # 3. Hold 3.0 seconds showing result on HUD / Tower lamp
        self.state = "RESULT_HOLD"
        if ai_result == "G":
            relay_controller.set_relay(config.RELAY_CH_GREEN, True)
            relay_controller.set_relay(config.RELAY_CH_YELLOW, False)
        else:
            relay_controller.set_relay(config.RELAY_CH_RED, True)
            relay_controller.set_relay(config.RELAY_CH_BUZZER, False)

        steps = 15
        hold_time = float(getattr(config, "RESULT_HOLD_TIME_SEC", 3.0) or 3.0)
        step_duration = hold_time / steps
        for i in range(steps, 0, -1):
            self.delay_remaining_sec = round(i * step_duration, 1)
            self.broadcast_state()
            await asyncio.sleep(step_duration)

        self.delay_remaining_sec = 0.0

        # 4. Final state transition after hold & save
        if ai_result == "G":
            # GOOD: Green light off, Yellow Standby ON
            self.active_alarm = False
            camera_service.clear_alarm_frame()
            relay_controller.set_relay(config.RELAY_CH_GREEN, False)
            relay_controller.set_relay(config.RELAY_CH_YELLOW, True)
            self.current_box_barcode = ""

            # Keep state as READY so system bounces back to Stage 2 for operator verification!
            self.state = "READY"
        else:
            # NOT GOOD (NG): Red light ON + Buzzer ON immediately, system locked!
            self.state = "ALARM_NG"
            self.active_alarm = True
            relay_controller.trigger_ng_alarm()
            # Freeze camera stream on defect image
            if base64_str:
                camera_service.freeze_alarm_frame(jpeg_bytes=base64.b64decode(base64_str))
            else:
                camera_service.freeze_alarm_frame()

        self.broadcast_state()

    def clear_alarm(self):
        """Clears NG alarm and unfreezes camera feed back to live view."""
        relay_controller.clear_alarm()
        self.active_alarm = False
        camera_service.clear_alarm_frame()
        if self.state == "ALARM_NG":
            self.state = "READY"
        self.broadcast_state()

    async def authorize_leader_bypass(self, leader_id: str, reason: str = "Leader Verification", decision: str = "G") -> Dict[str, Any]:
        """
        Leader authorizes verification of an NG box (Case 1: False NG -> G, or Case 2: Confirmed NG).
        Updates database inspection record, clears physical alarm, updates stats, and returns to READY.
        """
        if not self.active_alarm and self.state != "ALARM_NG" and not (self.last_inspection and self.last_inspection.get("result") == "NG"):
            return {"error": "ระบบไม่ได้อยู่ในสถานะเตือนภัย NG"}

        leader_id = (leader_id or "LEADER-01").strip()
        leader_upper = leader_id.upper()
        allowed = [x.upper() for x in config.AUTHORIZED_LEADER_IDS]
        if leader_upper not in allowed and not leader_upper.startswith("LEADER") and not leader_upper.startswith("MTL") and not leader_upper.startswith("ADMIN") and not leader_upper.startswith("SUPER"):
            return {"error": "รหัสพนักงานหัวหน้างานไม่ถูกต้อง หรือไม่ได้รับสิทธิ์"}

        decision = decision.upper().strip()
        if decision not in ["G", "NG"]:
            decision = "G"

        # Immediately transition state out of ALARM_NG so relay triggers broadcast READY
        self.state = "READY"
        self.active_alarm = False
        camera_service.clear_alarm_frame()
        relay_controller.clear_alarm()

        target_box_code = self.last_inspection.get("box_barcode", "") if self.last_inspection else (self.current_box_barcode or "")

        # Update last inspection record in database
        if self.last_inspection and self.last_inspection.get("id"):
            ins_id = self.last_inspection["id"]
            conn = db.get_connection()
            conn.execute("""
                UPDATE inspections
                SET final_result = ?, is_bypassed = 1, bypassed_by = ?, bypass_reason = ?
                WHERE id = ?
            """, (decision, leader_id, reason, ins_id))
            conn.commit()
            conn.close()

            if ins_id:
                asyncio.create_task(supabase_service.sync_leader_bypass(
                    inspection_id=ins_id,
                    leader_id=leader_id,
                    approved_result=decision,
                    bypass_reason=reason
                ))

            self.last_inspection["result"] = decision
            self.last_inspection["final_result"] = decision
            self.last_inspection["is_bypassed"] = True
            self.last_inspection["bypassed_by"] = leader_id
            self.last_inspection["bypass_reason"] = reason

        if decision == "G":
            # Flash green light 1.5s to confirm Good result
            relay_controller.trigger_good_result(1.5)
        else:
            # Standby yellow light for NG confirmation
            relay_controller.set_relay(config.RELAY_CH_YELLOW, True)

        # Reset current box barcode so workstation is ready for the next box
        self.current_box_barcode = ""

        # Recalculate summary from DB
        lot_summary = db.get_lot_summary(self.lot_number)
        total_done = lot_summary.get("inspections_total", 0)
        output_qty = lot_summary.get("output_qty", 0)
        total_work_qty = getattr(self, "total_work_qty", 2000) or 2000
        target = self.total_target_boxes
        is_lot_complete = bool(output_qty >= total_work_qty and total_work_qty > 0)

        if decision == "G" and is_lot_complete:
            self.state = "LOT_COMPLETE"
            new_defect = lot_summary.get("defect_qty", 0)
            db.close_lot(
                lot_number=self.lot_number,
                input_qty=output_qty + new_defect,
                output_qty=output_qty,
                defect_qty=new_defect,
                close_type="COMPLETED"
            )
            # Check leftover pieces
            box_nominal = int(self.qty_per_box or 700)
            reg_boxes = getattr(self, "registered_boxes", [])
            for b in reg_boxes:
                if str(b.get("box_no", "")).strip().upper() == str(target_box_code).strip().upper():
                    if b.get("is_carryover") or b.get("leftover_qty"):
                        box_nominal = int(b.get("leftover_qty") or 100)
                    break
            box_pieces = self.last_inspection.get("box_pieces", box_nominal) if self.last_inspection else box_nominal
            leftover = box_nominal - box_pieces
            # Leftover pieces calculated for this lot (not carried over to next lot)
            pass
            msg = f"หัวหน้างานยืนยันสิทธิ์: สรุปงานนี้เป็น [ G ] (งานดี แต่ขึ้น NG) และตรวจครบตามเป้าหมายแล้ว ({output_qty}/{total_work_qty} ชิ้น)"
        else:
            self.state = "READY"
            if decision == "G":
                msg = f"หัวหน้างานยืนยันสิทธิ์: สรุปงานนี้เป็น [ G ] (งานดี แต่ขึ้น NG) บันทึกข้อมูลเรียบร้อย"
            else:
                msg = f"หัวหน้างานยืนยันสิทธิ์: สรุปงานนี้เป็น [ NG ] (งานเสียจริง) บันทึกข้อมูลเรียบร้อย"

        self.broadcast_state()
        return {
            "success": True,
            "decision": decision,
            "bypassed_by": leader_id,
            "box_barcode": target_box_code,
            "is_lot_complete": is_lot_complete,
            "boxes_done": total_done,
            "target_boxes": target,
            "message": msg
        }

    
    async def close_lot(self, close_type: str = "COMPLETED") -> Dict[str, Any]:
        """Closes the current production lot, updates status in DB, and turns off relays."""
        lot_num = self.lot_number
        lot_summary = db.get_lot_summary(lot_num) if lot_num else {}
        output_qty = lot_summary.get("output_qty", 0)
        defect_qty = lot_summary.get("defect_qty", 0)
        input_qty = output_qty + defect_qty

        if lot_num:
            db.close_lot(
                lot_number=lot_num,
                input_qty=input_qty,
                output_qty=output_qty,
                defect_qty=defect_qty,
                close_type=close_type
            )
            # Asynchronously sync lot close status to Supabase Cloud
            asyncio.create_task(supabase_service.sync_lot({
                "lot_number": lot_num,
                "operator_id": self.operator_id,
                "part_model": self.part_model,
                "table_no": self.table_no,
                "inspection_no": self.inspection_no,
                "output_qty": output_qty,
                "defect_qty": defect_qty,
                "status": "Finish"
            }))

        self.state = "LOT_CLOSED"
        self.active_alarm = False
        self.current_box_barcode = ""
        self.dummy_good_passed = False
        self.dummy_ng_passed = False
        camera_service.clear_alarm_frame()
        relay_controller.turn_all_off()
        self.broadcast_state()

        return {
            "success": True,
            "lot_number": lot_num,
            "status": "CLOSED_COMPLETE" if close_type.upper() == "COMPLETED" else "CLOSED_PARTIAL",
            "message": f"ปิดล็อต {lot_num} เรียบร้อยแล้ว"
        }

    async def pause_lot(self, lot_number: str, defect_qty: int = 0, reject_qty: int = 0, registered_boxes: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Pauses the current lot (จบระหว่างล็อต) for lunch/shift break."""
        db.pause_lot(lot_number, defect_qty, reject_qty, registered_boxes or self.registered_boxes)
        
        # Asynchronously sync lot pause status to Supabase Cloud
        asyncio.create_task(supabase_service.sync_lot({
            "lot_number": lot_number,
            "operator_id": self.operator_id,
            "part_model": self.part_model,
            "table_no": self.table_no,
            "inspection_no": self.inspection_no,
            "defect_qty_input": defect_qty,
            "reject_qty_input": reject_qty,
            "status": "Pause"
        }))

        self.state = "DUMMY_TEST"
        self.dummy_good_passed = False
        self.dummy_ng_passed = False
        self.current_box_barcode = ""
        self.active_alarm = False
        camera_service.clear_alarm_frame()
        relay_controller.turn_all_off()
        relay_controller.set_relay(config.RELAY_CH_YELLOW, True)
        self.broadcast_state()
        return {"success": True, "message": f"พักงานล็อต {lot_number} เรียบร้อย (จบระหว่างล็อต)", "lot_number": lot_number}

    def check_and_resume_lot(self, lot_number: str, operator_id: str = None, operator_name: str = None, table_no: str = None) -> Dict[str, Any]:
        """Checks if lot can be resumed or joined from PAUSED, IN_PROGRESS, or incomplete CLOSED state."""
        lot = db.get_resumable_lot(lot_number.strip())
        if not lot:
            return {"is_resumed": False}
        
        self.lot_number = lot["lot_number"]
        if operator_id and str(operator_id).strip():
            self.operator_id = str(operator_id).strip()
        else:
            self.operator_id = lot.get("operator_id") or self.operator_id

        if operator_name and str(operator_name).strip():
            self.operator_name = str(operator_name).strip()
        else:
            self.operator_name = lot.get("operator_name") or self.operator_name

        if table_no and str(table_no).strip():
            self.table_no = str(table_no).strip()
        else:
            self.table_no = getattr(self, "table_no", "Offline07") or lot.get("table_no") or "Offline07"

        self.part_model = lot.get("part_model") or self.part_model
        self.inspection_no = lot.get("inspection_no") or "TEST21200"
        self.job_format = lot.get("job_format") or "กลาง"
        self.total_work_qty = int(lot.get("total_work_qty") or 2000)
        self.qty_per_box = int(lot.get("qty_per_box") or 700)
        self.total_target_boxes = int(lot.get("total_target_boxes") or len(lot.get("registered_boxes", [])) or 3)
        self.registered_boxes = lot.get("registered_boxes") or []
        
        inspections = [i for i in (lot.get("inspections") or []) if not str(i.get("box_barcode", "")).upper().startswith("DUMMY")]
        
        # Check if already tested dummy in DB or if any boxes were already inspected
        already_tested = bool(lot.get("dummy_tested")) or (len(inspections) > 0) or bool(self.dummy_good_passed and self.dummy_ng_passed)
        
        if already_tested:
            self.dummy_good_passed = True
            self.dummy_ng_passed = True
            self.state = "READY"
        else:
            self.dummy_good_passed = False
            self.dummy_ng_passed = False
            self.state = "DUMMY_TEST"
        
        # Resume status to IN_PROGRESS in database
        conn = db.get_connection()
        conn.execute("UPDATE production_lots SET status = 'IN_PROGRESS' WHERE lot_number = ?", (self.lot_number,))
        conn.commit()
        conn.close()
        
        self.current_box_barcode = ""
        self.active_alarm = False
        camera_service.clear_alarm_frame()
        relay_controller.turn_all_off()
        if self.state == "READY":
            relay_controller.trigger_standby()
        else:
            relay_controller.set_relay(config.RELAY_CH_YELLOW, True)
        self.broadcast_state()

        return {
            "is_resumed": True,
            "status": "IN_PROGRESS",
            "dummy_tested": already_tested,
            "dummy_status": {"good_passed": already_tested, "ng_passed": already_tested},
            "lot_number": self.lot_number,
            "operator_id": self.operator_id,
            "operator_name": self.operator_name,
            "part_model": self.part_model,
            "part_name": lot.get("part_model") or "E2E35A222MA387012F+M01/B",
            "inspection_no": self.inspection_no,
            "table_no": self.table_no,
            "job_format": self.job_format,
            "total_work_qty": self.total_work_qty,
            "qty_per_box": self.qty_per_box,
            "total_target_boxes": self.total_target_boxes,
            "registered_boxes": self.registered_boxes,
            "defect_qty": lot.get("defect_qty_input") or 0,
            "defect_qty_input": lot.get("defect_qty_input") or 0,
            "reject_qty": lot.get("reject_qty_input") or 0,
            "reject_qty_input": lot.get("reject_qty_input") or 0,
            "inspections": inspections,
            "inspections_total": len(inspections)
        }

# Global Singleton Instance
controller = InspectionController()
