"""
Database Management Module for Traceability & Production Logging
SQLite-based implementation compatible with SQL Database standards at Murata
"""

import sqlite3
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import config

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initializes tables for lots, inspections, and dummy test records."""
    conn = get_connection()
    cursor = conn.cursor()

    # Table: production_lots
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS production_lots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lot_number TEXT NOT NULL UNIQUE,
        operator_id TEXT NOT NULL,
        part_model TEXT NOT NULL,
        total_target_boxes INTEGER NOT NULL DEFAULT 10,
        qty_per_box INTEGER NOT NULL DEFAULT 50,
        current_boxes_done INTEGER DEFAULT 0,
        input_qty INTEGER DEFAULT 0,
        output_qty INTEGER DEFAULT 0,
        defect_qty INTEGER DEFAULT 0,
        status TEXT DEFAULT 'IN_PROGRESS',
        dummy_tested INTEGER DEFAULT 0,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
    )
    """)

    # Table: inspections
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS inspections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lot_number TEXT NOT NULL,
        box_barcode TEXT NOT NULL,
        box_index INTEGER DEFAULT 1,
        operator_id TEXT NOT NULL,
        part_model TEXT NOT NULL,
        ai_result TEXT NOT NULL,
        final_result TEXT NOT NULL,
        defect_type TEXT DEFAULT 'NONE',
        confidence_score REAL DEFAULT 0.0,
        cycle_time_ms INTEGER DEFAULT 2350,
        is_bypassed INTEGER DEFAULT 0,
        bypassed_by TEXT,
        bypass_reason TEXT,
        image_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Check and migrate columns if existing table didn't have defect_type or cycle_time_ms
    cursor.execute("PRAGMA table_info(inspections)")
    existing_cols = [row["name"] for row in cursor.fetchall()]
    if "defect_type" not in existing_cols:
        cursor.execute("ALTER TABLE inspections ADD COLUMN defect_type TEXT DEFAULT 'NONE'")
    if "cycle_time_ms" not in existing_cols:
        cursor.execute("ALTER TABLE inspections ADD COLUMN cycle_time_ms INTEGER DEFAULT 2350")
    if "box_pieces" not in existing_cols:
        cursor.execute("ALTER TABLE inspections ADD COLUMN box_pieces INTEGER DEFAULT 0")
    if "table_no" not in existing_cols:
        cursor.execute("ALTER TABLE inspections ADD COLUMN table_no TEXT DEFAULT 'Offline07'")
    if "operator_name" not in existing_cols:
        cursor.execute("ALTER TABLE inspections ADD COLUMN operator_name TEXT DEFAULT ''")

    # Check and migrate columns for production_lots
    cursor.execute("PRAGMA table_info(production_lots)")
    existing_lot_cols = [row["name"] for row in cursor.fetchall()]
    if "operator_name" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN operator_name TEXT DEFAULT ''")
    if "inspection_no" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN inspection_no TEXT DEFAULT 'TEST21200'")
    if "table_no" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN table_no TEXT DEFAULT 'Offline07'")
    if "job_format" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN job_format TEXT DEFAULT 'กลาง'")
    if "total_work_qty" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN total_work_qty INTEGER DEFAULT 2000")
    if "registered_boxes" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN registered_boxes TEXT DEFAULT '[]'")
    if "defect_qty_input" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN defect_qty_input INTEGER DEFAULT 0")
    if "reject_qty_input" not in existing_lot_cols:
        cursor.execute("ALTER TABLE production_lots ADD COLUMN reject_qty_input INTEGER DEFAULT 0")

    # Table: dummy_tests
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS dummy_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lot_number TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        sample_type TEXT NOT NULL,
        result TEXT NOT NULL,
        confidence_score REAL DEFAULT 0.0,
        tested_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Table: lot_carryovers (Tracks remaining/surplus pieces carried over to next lot)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS lot_carryovers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_lot_number TEXT NOT NULL,
        box_barcode TEXT NOT NULL,
        leftover_qty INTEGER NOT NULL,
        status TEXT DEFAULT 'PENDING',
        consumed_by_lot TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    conn.commit()
    conn.close()

def save_carryover(from_lot_number: str, box_barcode: str, leftover_qty: int) -> Dict[str, Any]:
    """Saves leftover fractional box remainder to carry over to next lot."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO lot_carryovers (from_lot_number, box_barcode, leftover_qty, status)
        VALUES (?, ?, ?, 'PENDING')
    """, (from_lot_number, box_barcode, leftover_qty))
    conn.commit()
    c_id = cursor.lastrowid
    cursor.execute("SELECT * FROM lot_carryovers WHERE id = ?", (c_id,))
    row = dict(cursor.fetchone())
    conn.close()
    return row

def get_pending_carryover() -> Optional[Dict[str, Any]]:
    """Fetches the latest unconsumed carryover record."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM lot_carryovers WHERE status = 'PENDING' ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def consume_carryover(carryover_id: int, consumed_by_lot: str):
    """Marks carryover as consumed by a new lot."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE lot_carryovers SET status = 'CONSUMED', consumed_by_lot = ? WHERE id = ?",
        (consumed_by_lot, carryover_id)
    )
    conn.commit()
    conn.close()

# ----------------- Operator Lookup -----------------
OPERATOR_MAP = {
    "91207": "SUTHEE RACHANAKUL",
    "MTL80343": "Aun",
    "LEADER-01": "Quality Leader (QA/QC)",
    "LEADER-02": "Supervisor (Line 1)",
    "OP-101": "Somchai Jaidee",
}

def lookup_operator_name(operator_id: str) -> str:
    clean_id = operator_id.strip()
    return OPERATOR_MAP.get(clean_id, "")

# ----------------- Production Lot Operations -----------------

def create_or_get_lot(
    lot_number: str,
    operator_id: str,
    part_model: str,
    total_target_boxes: int = 3,
    qty_per_box: int = 700,
    force_reset_if_closed: bool = True,
    operator_name: str = "",
    inspection_no: str = "TEST21200",
    table_no: str = "Offline07",
    job_format: str = "กลาง",
    total_work_qty: int = 2000
) -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()

    if not operator_name:
        operator_name = lookup_operator_name(operator_id) or "Aun"

    cursor.execute("SELECT * FROM production_lots WHERE lot_number = ?", (lot_number,))
    row = cursor.fetchone()

    if row:
        lot = dict(row)
        # If this lot was previously closed and is now being started as a new lot,
        # reset its status and clear previous inspections so it starts fresh at 0!
        if force_reset_if_closed and lot.get("status") in ["CLOSED_COMPLETE", "CLOSED_PARTIAL", "CLOSED"]:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute("""
                UPDATE production_lots
                SET status = 'IN_PROGRESS',
                    operator_id = ?,
                    operator_name = ?,
                    part_model = ?,
                    inspection_no = ?,
                    table_no = ?,
                    job_format = ?,
                    total_work_qty = ?,
                    total_target_boxes = ?,
                    qty_per_box = ?,
                    current_boxes_done = 0,
                    input_qty = 0,
                    output_qty = 0,
                    defect_qty = 0,
                    dummy_tested = 0,
                    started_at = ?,
                    closed_at = NULL
                WHERE lot_number = ?
            """, (
                operator_id,
                operator_name,
                part_model,
                inspection_no,
                table_no,
                job_format,
                total_work_qty,
                total_target_boxes,
                qty_per_box,
                now_str,
                lot_number
            ))
            cursor.execute("DELETE FROM inspections WHERE lot_number = ?", (lot_number,))
            conn.commit()
            cursor.execute("SELECT * FROM production_lots WHERE lot_number = ?", (lot_number,))
            lot = dict(cursor.fetchone())
        conn.close()
        return lot

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
        INSERT INTO production_lots 
        (lot_number, operator_id, operator_name, part_model, inspection_no, table_no, job_format, total_work_qty, total_target_boxes, qty_per_box, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        lot_number,
        operator_id,
        operator_name,
        part_model,
        inspection_no,
        table_no,
        job_format,
        total_work_qty,
        total_target_boxes,
        qty_per_box,
        now_str
    ))
    conn.commit()
    lot_id = cursor.lastrowid
    cursor.execute("SELECT * FROM production_lots WHERE id = ?", (lot_id,))
    new_lot = dict(cursor.fetchone())
    conn.close()
    return new_lot

def get_next_lot_number() -> str:
    """Generates the next sequential lot number based on the latest lot in DB."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT lot_number FROM production_lots ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()

    today_str = datetime.now().strftime("%Y%m%d")
    default_lot = f"LOT-{today_str}-01"

    if not row or not row["lot_number"]:
        return default_lot

    last_lot = str(row["lot_number"]).strip()
    match = re.search(r"^(.*?)(?:-(\d+))$", last_lot)
    if match:
        prefix = match.group(1)
        num_str = match.group(2)
        num = int(num_str) + 1
        padded = str(num).zfill(max(2, len(num_str)))
        return f"{prefix}-{padded}"
    return f"LOT-{today_str}-01"

def set_lot_dummy_tested(lot_number: str, tested: bool = True):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE production_lots SET dummy_tested = ? WHERE lot_number = ?",
        (1 if tested else 0, lot_number)
    )
    conn.commit()
    conn.close()


def pause_lot(lot_number: str, defect_qty: int = 0, reject_qty: int = 0, registered_boxes: list = None) -> Dict[str, Any]:
    """Pauses current lot (intermediate lot finish for breaks), saving state without finalizing as closed."""
    import json
    conn = get_connection()
    cursor = conn.cursor()
    reg_json = json.dumps(registered_boxes or [])
    cursor.execute("""
        UPDATE production_lots
        SET status = 'PAUSED',
            dummy_tested = 0,
            defect_qty_input = ?,
            reject_qty_input = ?,
            registered_boxes = ?
        WHERE lot_number = ?
    """, (defect_qty, reject_qty, reg_json, lot_number))
    conn.commit()
    cursor.execute("SELECT * FROM production_lots WHERE lot_number = ?", (lot_number,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {}

def get_resumable_lot(lot_number: str) -> Optional[Dict[str, Any]]:
    """Checks if lot exists and has pending work (or status PAUSED/IN_PROGRESS/incomplete) and returns its full state and inspections."""
    import json
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM production_lots WHERE lot_number = ? ORDER BY id DESC LIMIT 1", (lot_number,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None
    lot = dict(row)
    
    cursor.execute("SELECT * FROM inspections WHERE lot_number = ? AND (box_barcode IS NULL OR (box_barcode NOT LIKE 'DUMMY%' AND box_barcode NOT LIKE 'dummy%')) ORDER BY id ASC", (lot_number,))
    inspections = [dict(r) for r in cursor.fetchall()]
    conn.close()
    
    lot["inspections"] = inspections
    try:
        reg_boxes = json.loads(lot.get("registered_boxes") or "[]")
    except Exception:
        reg_boxes = []
    
    target_boxes = lot.get("total_target_boxes") or len(reg_boxes) or 3
    inspections_count = len(inspections)
    
    # If reg_boxes is empty, reconstruct from inspections and target boxes
    if not reg_boxes:
        reg_boxes = []
        for idx, insp in enumerate(inspections):
            reg_boxes.append({
                "ins_no": insp.get("box_index") or (idx + 1),
                "box_no": insp.get("box_barcode") or str(idx + 1),
                "time": insp.get("created_at") or "",
                "operator": insp.get("operator_id") or lot.get("operator_name") or "Operator"
            })
        for b_idx in range(len(inspections) + 1, target_boxes + 1):
            reg_boxes.append({
                "ins_no": b_idx,
                "box_no": str(b_idx),
                "time": "",
                "operator": lot.get("operator_name") or "Operator"
            })
    lot["registered_boxes"] = reg_boxes
    
    # Always resumable if it has inspections, or status is PAUSED/IN_PROGRESS, or has pending boxes!
    if inspections_count > 0 or lot.get("status") in ["PAUSED", "IN_PROGRESS"] or (inspections_count < target_boxes) or (len(reg_boxes) > inspections_count):
        return lot
    
    return None
    lot = dict(row)
    
    cursor.execute("SELECT * FROM inspections WHERE lot_number = ? AND (box_barcode IS NULL OR (box_barcode NOT LIKE 'DUMMY%' AND box_barcode NOT LIKE 'dummy%')) ORDER BY id ASC", (lot_number,))
    inspections = [dict(r) for r in cursor.fetchall()]
    conn.close()
    
    lot["inspections"] = inspections
    try:
        reg_boxes = json.loads(lot.get("registered_boxes") or "[]")
    except Exception:
        reg_boxes = []
    
    target_boxes = lot.get("total_target_boxes") or len(reg_boxes) or 3
    inspections_count = len(inspections)
    
    # If reg_boxes is empty, reconstruct from inspections and target boxes
    if not reg_boxes:
        reg_boxes = []
        for idx, insp in enumerate(inspections):
            reg_boxes.append({
                "ins_no": insp.get("box_index") or (idx + 1),
                "box_no": insp.get("box_barcode") or str(idx + 1),
                "time": insp.get("created_at") or "",
                "operator": insp.get("operator_id") or lot.get("operator_name") or "Operator"
            })
        for b_idx in range(len(inspections) + 1, target_boxes + 1):
            reg_boxes.append({
                "ins_no": b_idx,
                "box_no": str(b_idx),
                "time": "",
                "operator": lot.get("operator_name") or "Operator"
            })
    lot["registered_boxes"] = reg_boxes
    
    # Lot is resumable if:
    # 1. Status is PAUSED or IN_PROGRESS
    # 2. OR inspections_count < target_boxes (work is still pending to be continued!)
    # 3. OR len(reg_boxes) > inspections_count
    if lot.get("status") in ["PAUSED", "IN_PROGRESS"] or (inspections_count < target_boxes) or (len(reg_boxes) > inspections_count):
        return lot
    
    return None

def close_lot(lot_number: str, input_qty: int, output_qty: int, defect_qty: int, close_type: str = "COMPLETED") -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()
    status_str = "CLOSED_COMPLETE" if close_type.upper() == "COMPLETED" else "CLOSED_PARTIAL"
    cursor.execute("""
        UPDATE production_lots
        SET status = ?, input_qty = ?, output_qty = ?, defect_qty = ?, closed_at = ?
        WHERE lot_number = ?
    """, (
        status_str,
        input_qty,
        output_qty,
        defect_qty,
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        lot_number
    ))
    conn.commit()
    cursor.execute("SELECT * FROM production_lots WHERE lot_number = ?", (lot_number,))
    updated_lot = dict(cursor.fetchone())
    conn.close()
    return updated_lot

# ----------------- Inspection Operations -----------------

def record_inspection(
    lot_number: str,
    box_barcode: str,
    box_index: int,
    operator_id: str,
    part_model: str,
    ai_result: str,
    final_result: str,
    confidence_score: float,
    defect_type: str = "NONE",
    cycle_time_ms: int = 2350,
    image_path: Optional[str] = None,
    is_bypassed: bool = False,
    bypassed_by: Optional[str] = None,
    bypass_reason: Optional[str] = None,
    box_pieces: int = 0,
    table_no: str = "Offline07",
    operator_name: str = ""
) -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()

    if not operator_name:
        operator_name = lookup_operator_name(operator_id) or ""

    cursor.execute("""
        INSERT INTO inspections (
            lot_number, box_barcode, box_index, operator_id, part_model,
            ai_result, final_result, defect_type, confidence_score, cycle_time_ms,
            is_bypassed, bypassed_by, bypass_reason, image_path, box_pieces, created_at,
            table_no, operator_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        lot_number,
        box_barcode,
        box_index,
        operator_id,
        part_model,
        ai_result,
        final_result,
        defect_type,
        confidence_score,
        cycle_time_ms,
        1 if is_bypassed else 0,
        bypassed_by,
        bypass_reason,
        image_path,
        box_pieces,
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        table_no,
        operator_name
    ))
    conn.commit()
    ins_id = cursor.lastrowid

    # Update production lot count and live output/defect quantities accurately
    cursor.execute("SELECT qty_per_box, total_work_qty FROM production_lots WHERE lot_number = ?", (lot_number,))
    lot_q = cursor.fetchone()
    qty_box = box_pieces if box_pieces > 0 else (lot_q["qty_per_box"] if lot_q else 700)
    add_good = qty_box if final_result == "G" else 0
    add_defect = qty_box if final_result == "NG" else 0

    cursor.execute("""
        UPDATE production_lots
        SET current_boxes_done = current_boxes_done + 1,
            output_qty = output_qty + ?,
            defect_qty = defect_qty + ?
        WHERE lot_number = ?
    """, (add_good, add_defect, lot_number))
    conn.commit()

    cursor.execute("SELECT * FROM inspections WHERE id = ?", (ins_id,))
    rec = dict(cursor.fetchone())
    conn.close()
    return rec

def record_dummy_test(
    lot_number: str,
    operator_id: str,
    sample_type: str,
    result: str,
    confidence_score: float = 99.0
) -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO dummy_tests (
            lot_number, operator_id, sample_type, result, confidence_score, tested_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    """, (
        lot_number,
        operator_id,
        sample_type,
        result,
        confidence_score,
        datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ))
    conn.commit()
    dummy_id = cursor.lastrowid
    cursor.execute("SELECT * FROM dummy_tests WHERE id = ?", (dummy_id,))
    rec = dict(cursor.fetchone())
    conn.close()
    return rec

# ----------------- Query & Statistics -----------------

def get_lot_inspections(lot_number: str) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM inspections WHERE lot_number = ? ORDER BY id DESC", (lot_number,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_all_lots() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            p.*,
            COALESCE(SUM(CASE WHEN i.final_result = 'G' THEN 1 ELSE 0 END), 0) as real_good_boxes,
            COALESCE(SUM(CASE WHEN i.final_result = 'NG' THEN 1 ELSE 0 END), 0) as real_ng_boxes,
            COUNT(i.id) as real_inspected_boxes,
            COALESCE(SUM(CASE WHEN i.final_result = 'G' THEN COALESCE(i.box_pieces, 0) ELSE 0 END), 0) as sum_good_pieces,
            COALESCE(SUM(CASE WHEN i.final_result = 'NG' THEN COALESCE(i.box_pieces, 0) ELSE 0 END), 0) as sum_defect_pieces
        FROM production_lots p
        LEFT JOIN inspections i ON p.lot_number = i.lot_number AND (i.box_barcode IS NULL OR (i.box_barcode NOT LIKE 'DUMMY%' AND i.box_barcode NOT LIKE 'dummy%'))
        GROUP BY p.id
        ORDER BY p.id DESC
    """)
    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        if d["real_inspected_boxes"] > 0:
            d["current_boxes_done"] = d["real_inspected_boxes"]
            total_work = d.get("total_work_qty") or 2000
            good_pieces = d["sum_good_pieces"] if d["sum_good_pieces"] > 0 else (d["real_good_boxes"] * d["qty_per_box"])
            defect_pieces = d["sum_defect_pieces"] if d["sum_defect_pieces"] > 0 else (d["real_ng_boxes"] * d["qty_per_box"])
            d["output_qty"] = min(total_work, good_pieces)
            d["defect_qty"] = defect_pieces
        rows.append(d)
    conn.close()
    return rows

def get_all_inspections(limit: int = 100, lot_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    if lot_filter:
        cursor.execute("SELECT * FROM inspections WHERE lot_number = ? ORDER BY id DESC LIMIT ?", (lot_filter, limit))
    else:
        cursor.execute("SELECT * FROM inspections ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_lot_summary(lot_number: str) -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM production_lots WHERE lot_number = ?", (lot_number,))
    lot_row = cursor.fetchone()
    if not lot_row:
        conn.close()
        return {}
    lot = dict(lot_row)

    cursor.execute("""
        SELECT 
            COUNT(*) as total, 
            SUM(CASE WHEN final_result = 'G' THEN 1 ELSE 0 END) as good_count, 
            SUM(CASE WHEN final_result = 'NG' THEN 1 ELSE 0 END) as ng_count, 
            SUM(is_bypassed) as bypass_count,
            COALESCE(SUM(CASE WHEN final_result = 'G' THEN COALESCE(box_pieces, 0) ELSE 0 END), 0) as real_output_qty,
            COALESCE(SUM(CASE WHEN final_result = 'NG' THEN COALESCE(box_pieces, 0) ELSE 0 END), 0) as real_defect_qty
        FROM inspections 
        WHERE lot_number = ? AND (box_barcode IS NULL OR (box_barcode NOT LIKE 'DUMMY%' AND box_barcode NOT LIKE 'dummy%'))
    """, (lot_number,))
    stats_row = cursor.fetchone()

    ins_total = stats_row["total"] or 0
    good_boxes = stats_row["good_count"] or 0
    ng_boxes = stats_row["ng_count"] or 0
    qty_per_box = lot.get("qty_per_box", 700) or 700
    total_work_qty = lot.get("total_work_qty", 2000) or 2000

    calc_output = stats_row["real_output_qty"] or 0
    calc_defect = stats_row["real_defect_qty"] or 0
    if calc_output == 0 and good_boxes > 0:
        calc_output = min(total_work_qty, good_boxes * qty_per_box)

    lot["current_boxes_done"] = ins_total
    lot["output_qty"] = min(total_work_qty, calc_output)
    lot["defect_qty"] = calc_defect

    cursor.execute("SELECT * FROM inspections WHERE lot_number = ? AND (box_barcode IS NULL OR (box_barcode NOT LIKE 'DUMMY%' AND box_barcode NOT LIKE 'dummy%')) ORDER BY box_index ASC, id ASC", (lot_number,))
    inspections_list = [dict(r) for r in cursor.fetchall()]

    summary = {
        "lot": lot,
        "inspections_total": ins_total,
        "good_boxes": good_boxes,
        "ng_boxes": ng_boxes,
        "bypassed_boxes": stats_row["bypass_count"] or 0,
        "output_qty": lot["output_qty"],
        "defect_qty": lot["defect_qty"],
        "inspections": inspections_list
    }
    conn.close()
    return summary

# ----------------- Quality Analytics & Monitoring Queries -----------------

def get_analytics_summary() -> Dict[str, Any]:
    """Computes overall production & quality metrics across all lots."""
    conn = get_connection()
    cursor = conn.cursor()

    # Total counts from inspections
    cursor.execute("""
        SELECT 
            COUNT(*) as total_boxes,
            SUM(CASE WHEN final_result = 'G' THEN 1 ELSE 0 END) as good_boxes,
            SUM(CASE WHEN final_result = 'NG' THEN 1 ELSE 0 END) as ng_boxes,
            SUM(CASE WHEN is_bypassed = 1 THEN 1 ELSE 0 END) as bypassed_boxes,
            AVG(confidence_score) as avg_confidence,
            AVG(cycle_time_ms) as avg_cycle_time
        FROM inspections
    """)
    ins_row = cursor.fetchone()

    total_boxes = ins_row["total_boxes"] or 0
    good_boxes = ins_row["good_boxes"] or 0
    ng_boxes = ins_row["ng_boxes"] or 0
    bypassed_boxes = ins_row["bypassed_boxes"] or 0
    avg_confidence = round(ins_row["avg_confidence"] or 99.0, 1)
    avg_cycle_time = int(ins_row["avg_cycle_time"] or 2350)

    yield_rate = round((good_boxes / total_boxes * 100), 2) if total_boxes > 0 else 100.0
    defect_rate = round((ng_boxes / total_boxes * 100), 2) if total_boxes > 0 else 0.0

    # Total lots count
    cursor.execute("SELECT COUNT(*) as total_lots, SUM(CASE WHEN status LIKE 'CLOSED%' THEN 1 ELSE 0 END) as closed_lots FROM production_lots")
    lots_row = cursor.fetchone()
    total_lots = lots_row["total_lots"] or 0
    closed_lots = lots_row["closed_lots"] or 0
    active_lots = total_lots - closed_lots

    # Pieces estimation (assuming standard 50 pcs/box)
    total_good_pieces = good_boxes * 50
    total_defect_pieces = ng_boxes * 50

    conn.close()
    return {
        "total_boxes": total_boxes,
        "good_boxes": good_boxes,
        "ng_boxes": ng_boxes,
        "bypassed_boxes": bypassed_boxes,
        "yield_rate": yield_rate,
        "defect_rate": defect_rate,
        "total_good_pieces": total_good_pieces,
        "total_defect_pieces": total_defect_pieces,
        "avg_confidence": avg_confidence,
        "avg_cycle_time_ms": avg_cycle_time,
        "total_lots": total_lots,
        "active_lots": active_lots,
        "closed_lots": closed_lots
    }

def get_defect_pareto() -> List[Dict[str, Any]]:
    """Calculates defect type distribution and cumulative percentage for Pareto Chart."""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT 
            CASE 
                WHEN defect_type IS NULL OR defect_type = 'NONE' OR defect_type = '' THEN 'TAPE_COVERED'
                ELSE defect_type 
            END as defect_category,
            COUNT(*) as defect_count
        FROM inspections
        WHERE final_result = 'NG' OR is_bypassed = 1
        GROUP BY defect_category
        ORDER BY defect_count DESC
    """)
    rows = cursor.fetchall()
    conn.close()

    total_defects = sum(r["defect_count"] for r in rows)
    
    # Pre-defined descriptive labels in Thai
    labels_th = {
        "TAPE_COVERED": "มีเทปปิดทับขอบชิ้นงาน (Tape Covered)",
        "INVERTED": "ชิ้นงานใส่สลับด้าน / กลับหัว (Inverted)",
        "MISSING": "ชิ้นงานหาย / บรรจุไม่ครบ (Missing Piece)",
        "MISALIGNED": "ชิ้นงานเอียงไม่ลงล็อก (Misaligned)",
        "FOREIGN_OBJECT": "มีสิ่งแปลกปลอมในกล่อง (Foreign Object)"
    }

    # If no defects recorded yet, return standard simulated Pareto structure for monitoring demo
    if not rows or total_defects == 0:
        return [
            {"defect_type": "TAPE_COVERED", "label_th": labels_th["TAPE_COVERED"], "count": 14, "percentage": 58.3, "cumulative_percentage": 58.3},
            {"defect_type": "INVERTED", "label_th": labels_th["INVERTED"], "count": 6, "percentage": 25.0, "cumulative_percentage": 83.3},
            {"defect_type": "MISSING", "label_th": labels_th["MISSING"], "count": 3, "percentage": 12.5, "cumulative_percentage": 95.8},
            {"defect_type": "MISALIGNED", "label_th": labels_th["MISALIGNED"], "count": 1, "percentage": 4.2, "cumulative_percentage": 100.0}
        ]

    pareto_list = []
    cumulative = 0.0
    for r in rows:
        dtype = r["defect_category"]
        cnt = r["defect_count"]
        pct = round((cnt / total_defects) * 100, 1)
        cumulative = round(cumulative + pct, 1)
        pareto_list.append({
            "defect_type": dtype,
            "label_th": labels_th.get(dtype, dtype),
            "count": cnt,
            "percentage": pct,
            "cumulative_percentage": min(cumulative, 100.0)
        })

    return pareto_list

def get_hourly_trend() -> List[Dict[str, Any]]:
    """Returns inspection count and yield trend by hour."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            strftime('%H:00', created_at) as hour_slot,
            COUNT(*) as total,
            SUM(CASE WHEN final_result = 'G' THEN 1 ELSE 0 END) as good,
            SUM(CASE WHEN final_result = 'NG' THEN 1 ELSE 0 END) as ng
        FROM inspections
        GROUP BY hour_slot
        ORDER BY hour_slot ASC
        LIMIT 12
    """)
    rows = cursor.fetchall()
    conn.close()

    result = []
    for r in rows:
        tot = r["total"]
        g = r["good"] or 0
        ng = r["ng"] or 0
        y_rate = round((g / tot * 100), 1) if tot > 0 else 100.0
        result.append({
            "time_slot": r["hour_slot"],
            "total": tot,
            "good": g,
            "ng": ng,
            "yield_rate": y_rate
        })
    return result

def get_lots_comparison(limit: int = 10) -> List[Dict[str, Any]]:
    """Returns comparison metrics for recent production lots."""
    all_lots = get_all_lots()
    res = []
    for lot in all_lots[:limit]:
        total_boxes = lot.get("current_boxes_done", 0) or 0
        target = lot.get("total_target_boxes", 20) or 20
        good_boxes = (lot.get("output_qty", 0) or 0) // (lot.get("qty_per_box", 50) or 50)
        ng_boxes = (lot.get("defect_qty", 0) or 0) // (lot.get("qty_per_box", 50) or 50)
        yield_rate = round((good_boxes / total_boxes * 100), 1) if total_boxes > 0 else 100.0
        
        res.append({
            "lot_number": lot["lot_number"],
            "operator_id": lot["operator_id"],
            "part_model": lot["part_model"],
            "total_target_boxes": target,
            "current_boxes_done": total_boxes,
            "good_boxes": good_boxes,
            "ng_boxes": ng_boxes,
            "yield_rate": yield_rate,
            "status": lot["status"],
            "started_at": lot["started_at"],
            "closed_at": lot["closed_at"]
        })
    return res

def get_recent_defects(limit: int = 10) -> List[Dict[str, Any]]:
    """Returns recent NG defect records for live incident feed."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT * FROM inspections
        WHERE final_result = 'NG' OR is_bypassed = 1
        ORDER BY id DESC
        LIMIT ?
    """, (limit,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def clear_all_production_data():
    """Wipes all lots, inspections, dummy tests, and carryovers for a clean start."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM inspections")
    cursor.execute("DELETE FROM production_lots")
    cursor.execute("DELETE FROM dummy_tests")
    cursor.execute("DELETE FROM lot_carryovers")
    conn.commit()
    conn.close()

# Initialize database on module import
init_db()


# ----------------- Collaborative Multi-Station Operations -----------------

def get_active_lots() -> List[Dict[str, Any]]:
    """Returns all currently active / in-progress lots available for collaborative multi-station packing."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            p.*,
            COALESCE(SUM(CASE WHEN i.final_result = 'G' THEN 1 ELSE 0 END), 0) as real_good_boxes,
            COALESCE(SUM(CASE WHEN i.final_result = 'NG' THEN 1 ELSE 0 END), 0) as real_ng_boxes,
            COUNT(i.id) as real_inspected_boxes
        FROM production_lots p
        LEFT JOIN inspections i ON p.lot_number = i.lot_number AND (i.box_barcode IS NULL OR (i.box_barcode NOT LIKE 'DUMMY%' AND i.box_barcode NOT LIKE 'dummy%'))
        WHERE p.status IN ('IN_PROGRESS', 'PAUSED')
        GROUP BY p.id
        ORDER BY p.id DESC
    """)
    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        if d.get("real_inspected_boxes", 0) > 0:
            d["current_boxes_done"] = d["real_inspected_boxes"]
        target = d.get("total_target_boxes", 3) or 3
        if d["current_boxes_done"] >= target and target > 0:
            continue
        rows.append(d)
    conn.close()
    return rows

def get_lot_full_sync(lot_number: str) -> Dict[str, Any]:
    """Returns lot metadata, updated progress, and full list of box inspections with operator & table provenance."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            p.*,
            COALESCE(SUM(CASE WHEN i.final_result = 'G' THEN 1 ELSE 0 END), 0) as real_good_boxes,
            COALESCE(SUM(CASE WHEN i.final_result = 'NG' THEN 1 ELSE 0 END), 0) as real_ng_boxes,
            COUNT(i.id) as real_inspected_boxes
        FROM production_lots p
        LEFT JOIN inspections i ON p.lot_number = i.lot_number AND (i.box_barcode IS NULL OR (i.box_barcode NOT LIKE 'DUMMY%' AND i.box_barcode NOT LIKE 'dummy%'))
        WHERE p.lot_number = ?
        GROUP BY p.id
        ORDER BY p.id DESC LIMIT 1
    """, (lot_number,))
    lot_row = cursor.fetchone()
    if not lot_row:
        conn.close()
        return {}
    lot = dict(lot_row)
    
    cursor.execute("""
        SELECT id, lot_number, box_barcode, box_index, operator_id, operator_name, table_no,
               part_model, ai_result, final_result, defect_type, confidence_score, cycle_time_ms,
               created_at, image_path
        FROM inspections
        WHERE lot_number = ? AND (box_barcode IS NULL OR (box_barcode NOT LIKE 'DUMMY%' AND box_barcode NOT LIKE 'dummy%'))
        ORDER BY id ASC
    """, (lot_number,))
    inspections = [dict(r) for r in cursor.fetchall()]
    conn.close()
    
    total_inspected = len(inspections)
    good_boxes = sum(1 for i in inspections if i.get("final_result") == "G")
    ng_boxes = sum(1 for i in inspections if i.get("final_result") == "NG")
    
    stations_involved = sorted(list({str(i.get("table_no") or lot.get("table_no") or "Offline07") for i in inspections}))
    operators_involved = sorted(list({str(i.get("operator_name") or i.get("operator_id") or lot.get("operator_name") or "Operator") for i in inspections}))
    
    lot["inspections"] = inspections
    lot["current_boxes_done"] = total_inspected
    lot["real_good_boxes"] = good_boxes
    lot["real_ng_boxes"] = ng_boxes
    lot["stations_involved"] = stations_involved
    lot["operators_involved"] = operators_involved
    lot["is_multi_station"] = len(stations_involved) > 1
    
    return lot
