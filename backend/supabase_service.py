"""
Supabase Cloud Service & Dual-Sync Bridge
CiRA Image AI Workpiece Inspection System - Murata Electronics (Thailand) DX12
Synchronizes Lots, Box Inspections, Dummy Tests, and Evidence Images to Supabase Cloud
"""

import asyncio
import base64
import logging
from typing import Dict, Any, List, Optional
import httpx

import config

logger = logging.getLogger("cira.supabase")

class SupabaseService:
    def __init__(self):
        self.base_url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1"
        self.storage_url = f"{config.SUPABASE_URL.rstrip('/')}/storage/v1"
        self.api_key = config.SUPABASE_SECRET_KEY
        self.anon_key = config.SUPABASE_PUBLISHABLE_KEY
        self.bucket_name = config.SUPABASE_BUCKET_NAME
        self.is_enabled = getattr(config, "SUPABASE_ENABLED", True)

    def _get_headers(self, prefer_return: bool = True) -> Dict[str, str]:
        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if prefer_return:
            headers["Prefer"] = "return=representation,resolution=merge-duplicates"
        return headers

    async def check_health(self) -> Dict[str, Any]:
        """Checks connection status to Supabase Cloud."""
        if not self.is_enabled:
            return {"online": False, "reason": "Supabase disabled in config"}
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(
                    f"{self.base_url}/operators?select=operator_id&limit=1",
                    headers=self._get_headers(prefer_return=False)
                )
                if res.status_code == 200:
                    return {
                        "online": True,
                        "url": config.SUPABASE_URL,
                        "bucket": self.bucket_name,
                        "status": "CONNECTED"
                    }
                else:
                    return {
                        "online": False,
                        "status_code": res.status_code,
                        "error": res.text
                    }
        except Exception as e:
            return {"online": False, "error": str(e)}

    async def ensure_master_records(self, part_model: str, table_no: str, inspection_no: str, operator_id: str = "MTL80343"):
        """Ensures master records exist in Supabase to satisfy foreign key constraints."""
        if not self.is_enabled:
            return
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                if operator_id:
                    await client.post(
                        f"{self.base_url}/operators",
                        headers=self._get_headers(),
                        json={"operator_id": operator_id, "operator_name": f"Operator {operator_id}", "role": "OPERATOR"}
                    )
                await client.post(
                    f"{self.base_url}/part_models",
                    headers=self._get_headers(),
                    json={"part_model": part_model, "part_name": part_model, "default_qty_per_box": 700}
                )
                await client.post(
                    f"{self.base_url}/inspection_stations",
                    headers=self._get_headers(),
                    json={"table_no": table_no, "inspection_no": inspection_no, "line_name": "Packaging Line 01"}
                )
        except Exception:
            pass

    # ---------------- Production Lots Sync ----------------

    async def sync_lot(self, lot: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Upserts a production lot to Supabase."""
        if not self.is_enabled or not lot or not lot.get("lot_number"):
            return None

        # Clean/normalize values for Postgres schema
        raw_status = str(lot.get("status", "In Progress")).upper().replace("-", "_")
        if "CLOSE" in raw_status or "FINISH" in raw_status or "COMPLETE" in raw_status:
            status_val = "Finish"
        elif "PAUSE" in raw_status:
            status_val = "Pause"
        else:
            status_val = "In Progress"

        part_model = lot.get("part_model") or "E2E35A222MA387012F+M01/B"
        table_no = lot.get("table_no") or "Offline07"
        inspection_no = lot.get("inspection_no") or "TEST21200"

        operator_id = str(lot.get("operator_id", "MTL80343")).strip()
        await self.ensure_master_records(part_model, table_no, inspection_no, operator_id=operator_id)

        payload = {
            "lot_number": str(lot.get("lot_number")).strip(),
            "operator_id": operator_id,
            "part_model": part_model,
            "table_no": table_no,
            "inspection_no": inspection_no,
            "job_format": lot.get("job_format") or "Full Lot",
            "total_work_qty": int(lot.get("total_work_qty") or 2000),
            "output_qty": int(lot.get("output_qty") or 0),
            "defect_qty": int(lot.get("defect_qty_input") or lot.get("defect_qty") or 0),
            "reject_qty": int(lot.get("reject_qty_input") or lot.get("reject_qty") or 0),
            "total_target_boxes": int(lot.get("total_target_boxes") or 3),
            "qty_per_box": int(lot.get("qty_per_box") or 700),
            "status": status_val,
            "dummy_tested": bool(lot.get("dummy_tested", False))
        }

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.post(
                    f"{self.base_url}/production_lots",
                    headers=self._get_headers(),
                    json=payload
                )
                if res.status_code in (200, 201):
                    logger.info(f"Supabase: Synced lot {payload['lot_number']}")
                    return res.json()
                else:
                    logger.warning(f"Supabase sync_lot error {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Supabase sync_lot exception: {e}")
        return None

    # ---------------- Box Inspections Sync & Image Upload ----------------

    async def upload_evidence_image(self, image_bytes: bytes, filename: str) -> Optional[str]:
        """Uploads inspection photo to Supabase Storage and returns public URL."""
        if not self.is_enabled or not image_bytes:
            return None

        clean_filename = filename.replace("\\", "/").split("/")[-1]
        upload_url = f"{self.storage_url}/object/{self.bucket_name}/{clean_filename}"
        public_url = f"{self.storage_url}/object/public/{self.bucket_name}/{clean_filename}"

        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "image/jpeg",
            "x-upsert": "true"
        }

        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                res = await client.post(upload_url, headers=headers, content=image_bytes)
                if res.status_code in (200, 201):
                    logger.info(f"Supabase Storage: Uploaded image {clean_filename}")
                    return public_url
                else:
                    logger.warning(f"Supabase Storage upload error {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Supabase Storage exception: {e}")
        return None

    async def sync_box_inspection(
        self,
        lot_number: str,
        box_barcode: str,
        box_index: int,
        operator_id: str,
        ai_result: str,
        final_result: str,
        confidence_score: float = 0.0,
        cycle_time_ms: int = 2350,
        gap_time: float = 0.0,
        defect_type: str = "NONE",
        image_bytes: Optional[bytes] = None,
        image_url: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Syncs a single box inspection record and optionally uploads image to Supabase Storage."""
        if not self.is_enabled:
            return None

        # Upload image if provided as bytes
        uploaded_url = image_url
        if image_bytes and not uploaded_url:
            filename = f"insp_{lot_number}_{box_barcode}.jpg"
            uploaded_url = await self.upload_evidence_image(image_bytes, filename)

        # Normalize defect code
        clean_defect = defect_type.upper().replace(" ", "_") if defect_type else "NONE"
        if clean_defect not in ("NONE", "MISSING", "WRONG_PART", "FOREIGN_OBJECT", "SCRATCH"):
            clean_defect = "NONE" if final_result == "G" else "MISSING"

        clean_op = str(operator_id or "MTL80343").strip()
        await self.ensure_master_records(part_model="E2E35A222MA387012F+M01/B", table_no="Offline07", inspection_no="TEST21200", operator_id=clean_op)

        payload = {
            "lot_number": lot_number,
            "box_barcode": box_barcode,
            "box_index": int(box_index or 1),
            "operator_id": clean_op,
            "ai_result": ai_result.upper(),
            "final_result": final_result.upper(),
            "defect_code": clean_defect,
            "confidence_score": float(confidence_score or 0.0),
            "cycle_time_ms": int(cycle_time_ms or 2350),
            "gap_time": round(float(gap_time or 0.0), 2),
            "image_path": uploaded_url or ""
        }

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.post(
                    f"{self.base_url}/box_inspections",
                    headers=self._get_headers(),
                    json=payload
                )
                if res.status_code in (200, 201):
                    logger.info(f"Supabase: Synced box {box_barcode} of {lot_number}")
                    return res.json()
                else:
                    logger.warning(f"Supabase sync_box_inspection error {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Supabase sync_box_inspection exception: {e}")
        return None

    # ---------------- Dummy Tests Sync ----------------

    async def sync_dummy_test(
        self,
        lot_number: str,
        operator_id: str,
        sample_type: str,
        actual_result: str,
        passed: bool
    ) -> Optional[Dict[str, Any]]:
        """Syncs Poka-Yoke dummy test event to Supabase."""
        if not self.is_enabled:
            return None

        is_good = (sample_type == "GOOD_SAMPLE")
        expected = "G" if is_good else "NG"

        payload = {
            "lot_number": lot_number,
            "operator_id": operator_id or "MTL80343",
            "sample_type": sample_type,
            "expected_result": expected,
            "actual_result": actual_result.upper(),
            "passed": bool(passed)
        }

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.post(
                    f"{self.base_url}/dummy_verification_tests",
                    headers=self._get_headers(),
                    json=payload
                )
                if res.status_code in (200, 201):
                    logger.info(f"Supabase: Synced dummy test {sample_type} for lot {lot_number}")
                    return res.json()
                else:
                    logger.warning(f"Supabase sync_dummy_test error {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Supabase sync_dummy_test exception: {e}")
        return None

    # ---------------- Leader Bypass Sync ----------------

    async def sync_leader_bypass(
        self,
        inspection_id: int,
        leader_id: str,
        approved_result: str,
        bypass_reason: str
    ) -> Optional[Dict[str, Any]]:
        """Syncs Leader Bypass Authorization record to Supabase."""
        if not self.is_enabled:
            return None

        payload = {
            "inspection_id": inspection_id,
            "leader_id": leader_id,
            "original_result": "NG",
            "approved_result": approved_result.upper(),
            "bypass_reason": bypass_reason
        }

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.post(
                    f"{self.base_url}/leader_bypasses",
                    headers=self._get_headers(),
                    json=payload
                )
                if res.status_code in (200, 201):
                    return res.json()
        except Exception as e:
            logger.error(f"Supabase sync_leader_bypass exception: {e}")
        return None

    # ---------------- Legacy 16-Columns View Query ----------------

    async def get_legacy_history(self, lot_filter: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
        """Queries the 16-columns legacy view from Supabase."""
        if not self.is_enabled:
            return []

        url = f"{self.base_url}/v_legacy_inspection_history?select=*&order=CheckTime.desc&limit={limit}"
        if lot_filter:
            url += f"&LotNo=eq.{lot_filter}"

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(url, headers=self._get_headers(prefer_return=False))
                if res.status_code == 200:
                    return res.json()
                else:
                    logger.warning(f"Supabase get_legacy_history error {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Supabase get_legacy_history exception: {e}")
        return []


    async def get_lots(self) -> Optional[List[Dict[str, Any]]]:
        if not self.is_enabled:
            return None
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(
                    f"{self.base_url}/production_lots?select=*&order=started_at.desc",
                    headers=self._get_headers(prefer_return=False)
                )
                if res.status_code == 200:
                    lots = res.json()
                    for l in lots:
                        l['current_boxes_done'] = l.get('total_target_boxes', 0) if l.get('status') == 'Finish' else 0
                        l['real_inspected_boxes'] = l.get('total_target_boxes', 0) if l.get('status') == 'Finish' else 0
                        l['real_good_boxes'] = l.get('total_target_boxes', 0) if l.get('status') == 'Finish' else 0
                        l['real_ng_boxes'] = 0
                        l['sum_good_pieces'] = l.get('output_qty', 0)
                        l['sum_defect_pieces'] = l.get('defect_qty', 0)
                    return lots
        except Exception as e:
            logger.error(f"Supabase get_lots error: {e}")
        return None

    async def get_inspections(self, lot_filter: Optional[str] = None, limit: int = 150) -> Optional[List[Dict[str, Any]]]:
        if not self.is_enabled:
            return None
        try:
            url = f"{self.base_url}/box_inspections?select=*&order=created_at.desc&limit={limit}"
            if lot_filter:
                url += f"&lot_number=eq.{lot_filter}"
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(url, headers=self._get_headers(prefer_return=False))
                if res.status_code == 200:
                    return res.json()
        except Exception as e:
            logger.error(f"Supabase get_inspections error: {e}")
        return None

    async def clear_all_supabase_data(self) -> Dict[str, Any]:
        if not self.is_enabled:
            return {"success": False, "error": "Supabase disabled"}
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.delete(f"{self.base_url}/leader_bypasses?id=gte.0", headers=self._get_headers(prefer_return=False))
                await client.delete(f"{self.base_url}/dummy_verification_tests?id=gte.0", headers=self._get_headers(prefer_return=False))
                await client.delete(f"{self.base_url}/box_inspections?id=gte.0", headers=self._get_headers(prefer_return=False))
                await client.delete(f"{self.base_url}/registered_boxes?id=gte.0", headers=self._get_headers(prefer_return=False))
                await client.delete(f"{self.base_url}/production_lots?status=neq.DUMMY_NEVER", headers=self._get_headers(prefer_return=False))
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ---------------- Initial Full Sync from SQLite ----------------

    async def sync_all_from_local(self, db_module) -> Dict[str, Any]:
        """Reads all local SQLite lots and inspections and syncs them to Supabase Cloud."""
        lots = db_module.get_all_lots()
        inspections = db_module.get_all_inspections(limit=1000)

        synced_lots = 0
        synced_inspections = 0

        # Sync lots first
        for lot in lots:
            res = await self.sync_lot(lot)
            if res:
                synced_lots += 1

        # Sync inspections
        for insp in inspections:
            res = await self.sync_box_inspection(
                lot_number=insp.get("lot_number"),
                box_barcode=insp.get("box_barcode"),
                box_index=insp.get("box_index", 1),
                operator_id=insp.get("operator_id"),
                ai_result=insp.get("ai_result", "G"),
                final_result=insp.get("final_result", "G"),
                confidence_score=insp.get("confidence_score", 0.0),
                cycle_time_ms=insp.get("cycle_time_ms", 2350),
                defect_type=insp.get("defect_type", "NONE")
            )
            if res:
                synced_inspections += 1

        return {
            "success": True,
            "synced_lots": synced_lots,
            "synced_inspections": synced_inspections,
            "total_local_lots": len(lots),
            "total_local_inspections": len(inspections)
        }

# Global Singleton
    async def get_active_lots(self) -> List[Dict[str, Any]]:
        """Fetch active in-progress lots from Supabase Cloud."""
        if not self.is_enabled:
            return []
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(
                    f"{self.base_url}/production_lots?status=in.(In%20Progress,Pause)&order=created_at.desc&limit=10",
                    headers=self._get_headers(prefer_return=False)
                )
                if res.status_code == 200:
                    return res.json()
        except Exception as e:
            logger.warning(f"Supabase get_active_lots error: {e}")
        return []

supabase_service = SupabaseService()
