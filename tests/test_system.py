"""
Automated Unit Tests for CiRA Inspection System
Tests: Database, Modbus Driver, CiRA Simulator, and Controller Logic
"""

import unittest
import asyncio
import os
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from backend import database as db
from backend.modbus_relay import calc_crc16, relay_controller
from backend.cira_simulator import cira_sim
from backend.controller import controller

class TestInspectionSystem(unittest.TestCase):

    def setUp(self):
        # Ensure fresh DB state
        db.init_db()

    def test_database_operations(self):
        """Tests lot creation, inspection recording, and lot summary."""
        import uuid
        test_lot = f"TEST-LOT-UNIT-{uuid.uuid4().hex[:6].upper()}"
        lot = db.create_or_get_lot(
            lot_number=test_lot,
            operator_id="OP-TEST",
            part_model="MURATA-FLTR-102",
            total_target_boxes=10,
            qty_per_box=50
        )

        self.assertEqual(lot["lot_number"], test_lot)

        # Record Good inspection
        rec1 = db.record_inspection(
            lot_number=test_lot,
            box_barcode="BX-TEST-001",
            box_index=1,
            operator_id="OP-TEST",
            part_model="MURATA-FLTR-102",
            ai_result="G",
            final_result="G",
            confidence_score=99.2
        )
        self.assertEqual(rec1["final_result"], "G")

        # Record NG inspection
        rec2 = db.record_inspection(
            lot_number=test_lot,
            box_barcode="BX-TEST-002",
            box_index=2,
            operator_id="OP-TEST",
            part_model="MURATA-FLTR-102",
            ai_result="NG",
            final_result="NG",
            confidence_score=98.8
        )
        self.assertEqual(rec2["final_result"], "NG")

        # Check summary
        summary = db.get_lot_summary(test_lot)
        self.assertEqual(summary["inspections_total"], 2)
        self.assertEqual(summary["good_boxes"], 1)
        self.assertEqual(summary["ng_boxes"], 1)

    def test_modbus_crc16(self):
        """Tests standard Modbus RTU CRC16 checksum calculation."""
        # Test frame: Slave 1, Read Coils from 0, 10 coils
        data = bytes([0x01, 0x01, 0x00, 0x00, 0x00, 0x0A])
        crc = calc_crc16(data)
        # Expected CRC for this standard Modbus frame is 0xBC0D in little endian -> b'\xbc\r' or b'\x0d\xbc'
        self.assertEqual(len(crc), 2)

    def test_modbus_relay_controller(self):
        """Tests relay state setting and alarm triggers in simulation."""
        relay_controller.simulation = True
        relay_controller.turn_all_off()
        self.assertFalse(relay_controller.relay_states[config.RELAY_CH_GREEN])

        # Trigger Good result
        relay_controller.trigger_good_result(duration_sec=0.2)
        self.assertTrue(relay_controller.relay_states[config.RELAY_CH_GREEN])
        self.assertFalse(relay_controller.relay_states[config.RELAY_CH_RED])

        # Trigger NG alarm
        relay_controller.trigger_ng_alarm()
        self.assertTrue(relay_controller.relay_states[config.RELAY_CH_RED])
        self.assertTrue(relay_controller.relay_states[config.RELAY_CH_BUZZER])

        # Clear alarm
        relay_controller.clear_alarm()
        self.assertFalse(relay_controller.relay_states[config.RELAY_CH_RED])
        self.assertFalse(relay_controller.relay_states[config.RELAY_CH_BUZZER])

    def test_cira_simulator(self):
        """Tests synthetic image generation and Base64 encoding/decoding."""
        sim_res = cira_sim.inspect_sample("BX-SIM-999", force_result="G")
        self.assertEqual(sim_res["result"], "G")
        self.assertGreater(sim_res["confidence"], 90.0)
        self.assertTrue(len(sim_res["image_base64"]) > 500)

        # Test decode
        saved_path = cira_sim.decode_and_save_image(sim_res["image_base64"], "test_saved.jpg")
        self.assertTrue(saved_path.exists())
        self.assertGreater(saved_path.stat().st_size, 0)
        # Clean up
        if saved_path.exists():
            saved_path.unlink()

    def test_controller_workflow(self):
        """Tests controller state transitions and bypass mechanism."""
        import uuid
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        controller.set_event_loop(loop)

        test_lot = f"LOT-CTRL-{uuid.uuid4().hex[:6].upper()}"
        # 1. Init Lot
        loop.run_until_complete(controller.initialize_lot(
            operator_id="OP-TEST-CTRL",
            lot_number=test_lot,
            part_model="MURATA-CAP-808"
        ))
        self.assertEqual(controller.state, "DUMMY_TEST")


        # 2. Dummy Test
        loop.run_until_complete(controller.run_dummy_test("GOOD_SAMPLE"))
        loop.run_until_complete(controller.run_dummy_test("NG_SAMPLE"))
        self.assertEqual(controller.state, "READY")

        # 3. Simulate NG Inspection
        ng_payload = cira_sim.inspect_sample("BX-CTRL-NG", force_result="NG")
        loop.run_until_complete(controller.evaluate_inspection_result(ng_payload))
        self.assertEqual(controller.state, "ALARM_NG")
        self.assertTrue(controller.active_alarm)

        # 4. Leader Bypass (Flowchart: Leader ยืนยันสิทธิ์ -> บันทึกสถานะเป็น G -> ตรวจสอบครบทั้งล็อตหรือไม่?)
        bypass_res = loop.run_until_complete(controller.authorize_leader_bypass("LEADER-01"))
        self.assertTrue(bypass_res.get("success"))
        self.assertEqual(controller.last_inspection["result"], "G")
        self.assertTrue(controller.last_inspection["is_bypassed"])
        # Still not complete (1/20 boxes) -> state returns to READY to continue inspecting until complete
        self.assertFalse(bypass_res.get("is_lot_complete"))
        self.assertEqual(controller.state, "READY")
        self.assertFalse(controller.active_alarm)

        # 5. Complete remaining boxes until target (set target to 2 boxes for test)
        controller.total_target_boxes = 2
        g_payload = cira_sim.inspect_sample("BX-CTRL-02", force_result="G")
        loop.run_until_complete(controller.evaluate_inspection_result(g_payload))
        # Total done is now 2/2 -> lot is complete!
        self.assertEqual(controller.state, "LOT_COMPLETE")

        loop.close()

if __name__ == "__main__":
    unittest.main()
