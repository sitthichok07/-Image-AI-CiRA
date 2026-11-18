"""
CiRA CORE Deep Learning AI Simulator & Sample Image Generator
Simulates CiRA CORE output payload (Good: G / Not Good: NG) with Base64 images
Based on actual workpiece test cases from Chapter 4 of the project report
"""

import base64
import io
import time
import random
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Tuple
from PIL import Image, ImageDraw, ImageFont
import config

class CiRASimulator:
    """
    Simulates CiRA CORE Deep Detect node response:
    - Analyzes packaging workpiece orientation
    - G: Correct packing orientation (No blue tape)
    - NG: Upside-down / reversed orientation (With blue tape)
    - Returns Base64 JPEG string and Confidence Score (~99.0%)
    """

    def __init__(self, sample_dir: Path = config.SAMPLE_IMAGES_DIR):
        self.sample_dir = sample_dir
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_sample_images()

    def _ensure_sample_images(self):
        """Generates synthetic baseline images if not already present."""
        good_path = self.sample_dir / "sample_good.jpg"
        ng_path = self.sample_dir / "sample_ng.jpg"

        if not good_path.exists():
            img_g = self._create_synthetic_workpiece(is_good=True)
            img_g.save(good_path, "JPEG", quality=90)

        if not ng_path.exists():
            img_ng = self._create_synthetic_workpiece(is_good=False)
            img_ng.save(ng_path, "JPEG", quality=90)

    def _create_synthetic_workpiece(self, is_good: bool, box_code: str = "BX-001") -> Image.Image:
        """
        Creates an image representing the electronic workpiece tape array in the box.
        - Background: workstation sliding jig & polycarbonate packaging box.
        - Content: vertical electronic component rows.
        - If NG: includes blue masking tape strip on the wrong orientation.
        """
        width, height = 640, 480
        img = Image.new("RGB", (width, height), color=(220, 225, 230))
        draw = ImageDraw.Draw(img)

        # Draw sliding jig / conveyor background
        draw.rectangle([20, 40, width - 20, height - 40], fill=(180, 185, 190), outline=(100, 105, 110), width=3)
        draw.rectangle([60, 80, width - 60, height - 80], fill=(245, 245, 248), outline=(60, 60, 70), width=4)

        # Draw workpiece strip rows (multiple pins/connectors)
        num_pins = 24
        spacing = (width - 160) // num_pins
        for i in range(num_pins):
            x = 80 + i * spacing
            # Connector body
            draw.rectangle([x, 140, x + spacing - 4, 340], fill=(210, 190, 150), outline=(140, 120, 90), width=2)
            # Pins / contacts at top
            draw.rectangle([x + 2, 110, x + spacing - 6, 140], fill=(192, 192, 192), outline=(100, 100, 100))
            # Detail lines
            draw.line([(x + 4, 180), (x + spacing - 8, 180)], fill=(120, 100, 80), width=1)
            draw.line([(x + 4, 260), (x + spacing - 8, 260)], fill=(120, 100, 80), width=1)

        if not is_good:
            # Defect signature: Blue tape taped across or wrong direction label
            draw.rectangle([100, 120, 360, 180], fill=(30, 144, 255), outline=(0, 80, 200), width=2)
            draw.text((120, 140), "TAPE / REVERSED (NG)", fill=(255, 255, 255))
        else:
            # Good signature: Clean alignment
            draw.rectangle([100, 110, 320, 135], fill=(34, 139, 34), outline=(0, 100, 0), width=1)
            draw.text((120, 115), "CORRECT ORIENTATION (G)", fill=(255, 255, 255))

        # Add AI Bounding Box overlay (emulating CiRA CORE Deep Detect)
        bbox_color = (0, 230, 0) if is_good else (255, 30, 30)
        label_text = f"{'G' if is_good else 'NG'} {random.uniform(98.2, 99.8):.2f}%"
        draw.rectangle([70, 90, width - 70, height - 90], outline=bbox_color, width=4)
        draw.rectangle([70, 90, 220, 125], fill=bbox_color)
        draw.text((80, 96), label_text, fill=(255, 255, 255))

        # Timestamp & Barcode watermark
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        draw.text((30, height - 30), f"Murata DX12 Inspection | Box: {box_code} | {ts}", fill=(50, 50, 50))

        return img

    def _get_good_sample_files(self) -> list:
        candidates = []
        for d in [self.sample_dir / "g", Path("รูปงาน G"), self.sample_dir]:
            if d.exists():
                for ext in ("*.png", "*.jpg", "*.jpeg"):
                    candidates.extend(d.glob(ext))
        result = [
            p for p in candidates
            if "ng" not in str(p.parent.name).lower()
            and not p.stem.lower().startswith("real_ng")
            and not p.stem.lower().startswith("sample_ng")
            and p.is_file()
        ]
        return sorted(list(set(result)))

    def _get_ng_sample_files(self) -> list:
        candidates = []
        for d in [self.sample_dir / "ng", Path("รูปงาน NG"), self.sample_dir]:
            if d.exists():
                for ext in ("*.png", "*.jpg", "*.jpeg"):
                    candidates.extend(d.glob(ext))
        result = [
            p for p in candidates
            if ("ng" in str(p.parent.name).lower() or p.stem.lower().startswith("real_ng") or p.stem.lower().startswith("sample_ng"))
            and p.is_file()
        ]
        return sorted(list(set(result)))

    def inspect_sample(
        self,
        box_barcode: str = "BX-001",
        force_result: str = "RANDOM"
    ) -> Dict[str, Any]:
        """
        Executes simulated inspection on a box.
        Uses high-definition real samples from 'รูปงาน G' and 'รูปงาน NG' folders.
        """
        if force_result.upper() == "G":
            is_good = True
        elif force_result.upper() == "NG":
            is_good = False
        else:
            is_good = random.random() > 0.15  # 85% Good, 15% NG default

        confidence = 99.0
        ai_result = "G" if is_good else "NG"
        if is_good:
            defect_type = "NONE"
        else:
            defect_type = random.choices(
                ["TAPE_COVERED", "INVERTED", "MISSING", "MISALIGNED"],
                weights=[0.55, 0.30, 0.10, 0.05]
            )[0]

        # Gather real HD sample images from รูปงาน G / รูปงาน NG
        real_g_files = self._get_good_sample_files()
        real_ng_files = self._get_ng_sample_files()

        if is_good and real_g_files:
            img = Image.open(random.choice(real_g_files)).convert("RGB")
        elif not is_good and real_ng_files:
            img = Image.open(random.choice(real_ng_files)).convert("RGB")
        else:
            img = self._create_synthetic_workpiece(is_good=is_good, box_code=box_barcode)

        # Encode to Base64 (JPEG HD lossless-grade)
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=98, subsampling=0)
        img_bytes = buffer.getvalue()

        base64_str = base64.b64encode(img_bytes).decode("utf-8")

        return {
            "status": "SUCCESS",
            "result": ai_result,
            "defect_type": defect_type,
            "confidence": confidence,
            "box_barcode": box_barcode,
            "cycle_time_ms": random.randint(2150, 2480),
            "timestamp": datetime.now().isoformat(),
            "image_base64": base64_str,
            "image_format": "jpeg"
        }

    def decode_and_save_image(self, base64_str: str, target_filename: str) -> Path:
        """Decodes Base64 string from CiRA CORE and saves to inspections folder."""
        target_path = config.INSPECTIONS_DIR / target_filename
        img_bytes = base64.b64decode(base64_str)
        with open(target_path, "wb") as f:
            f.write(img_bytes)
        return target_path

# Global Singleton Instance
cira_sim = CiRASimulator()
