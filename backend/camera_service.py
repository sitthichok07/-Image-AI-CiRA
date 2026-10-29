"""
Camera Service for Real-Time Workpiece Inspection & Video Streaming
Supports:
1. Physical USB 1080p Webcam (via OpenCV VideoCapture)
2. CiRA CORE MQTT / Base64 Frame Ingestion
3. Synthetic Simulated Workpiece Generator (fallback if no physical camera connected)
"""

import cv2
import time
import threading
import base64
import numpy as np
from pathlib import Path
from typing import Optional, Tuple, Dict, Any
from PIL import Image
import config
from backend.cira_simulator import cira_sim

class CameraService:
    def __init__(self, camera_index: int = 0):
        self.camera_index = camera_index
        self.cap: Optional[cv2.VideoCapture] = None
        self.is_running = False
        self.lock = threading.Lock()
        self.latest_frame: Optional[np.ndarray] = None
        self.latest_frame_jpeg: Optional[bytes] = None
        self.use_mock_stream = False
        self._thread: Optional[threading.Thread] = None
        self.is_alarm_frozen = False
        self.hold_until = 0.0

        # Camera is initialized lazily when start_stream() is called
        self._initialized = False

    def _init_camera(self):
        if self._initialized:
            return
        self._initialized = True
        
        # When SIMULATION_MODE is enabled (e.g. testing without an overhead industrial vision camera):
        # Always stream authentic workpiece inspection images (Good/NG packing) instead of laptop webcam!
        if getattr(config, "SIMULATION_MODE", True):
            print("[CameraService] Simulation Mode active: Streaming workpiece inspection sample images (Good/NG) instead of webcam.")
            self.use_mock_stream = True
            if self.cap:
                self.cap.release()
                self.cap = None
            return

        try:
            self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
            if self.cap.isOpened():
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                ret, test_frame = self.cap.read()
                if ret and test_frame is not None:
                    print(f"[CameraService] Hardware camera opened at index {self.camera_index}")
                    self.use_mock_stream = False
                else:
                    self.cap.release()
                    self.cap = None
                    self.use_mock_stream = True
            else:
                self.use_mock_stream = True
        except Exception as e:
            print(f"[CameraService] Cannot open hardware camera: {e}. Using mock generator.")
            self.use_mock_stream = True

    def start_stream(self):
        if self.is_running:
            return
        self._init_camera()
        self.is_running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()

    def stop_stream(self):
        self.is_running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        if self.cap and self.cap.isOpened():
            self.cap.release()

    def _capture_loop(self):
        while self.is_running:
            # During NG alarm, freeze and hold the defective workpiece image with red box
            if self.is_alarm_frozen:
                time.sleep(0.1)
                continue

            if not self.use_mock_stream and self.cap and self.cap.isOpened():
                ret, frame = self.cap.read()
                if ret and frame is not None:
                    with self.lock:
                        self.latest_frame = frame
                        ret_enc, jpeg = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                        if ret_enc:
                            self.latest_frame_jpeg = jpeg.tobytes()
                else:
                    time.sleep(0.05)
            else:
                # If currently holding an active inspection result (Good/NG), preserve it!
                if self.hold_until and time.time() < self.hold_until and self.latest_frame_jpeg is not None:
                    time.sleep(0.1)
                    continue

                # Stream authentic workpiece inspection sample image (Good workpiece baseline from รูปงาน G)
                g_candidates = []
                for folder in [config.SAMPLE_IMAGES_DIR / "g", Path("รูปงาน G"), config.SAMPLE_IMAGES_DIR]:
                    if folder.exists():
                        for ext in ("*.png", "*.jpg", "*.jpeg"):
                            g_candidates.extend(folder.glob(ext))
                g_candidates = [
                    p for p in g_candidates
                    if "ng" not in str(p.parent.name).lower()
                    and not p.stem.lower().startswith("real_ng")
                    and not p.stem.lower().startswith("sample_ng")
                    and p.is_file()
                ]
                sample_img_path = g_candidates[0] if g_candidates else None
                if sample_img_path and sample_img_path.exists():
                    try:
                        pil_im = Image.open(str(sample_img_path)).convert("RGB")
                        frame = cv2.cvtColor(np.array(pil_im), cv2.COLOR_RGB2BGR)
                    except Exception:
                        frame = cv2.cvtColor(np.array(cira_sim._create_synthetic_workpiece(is_good=True)), cv2.COLOR_RGB2BGR)
                else:
                    mock_img = cira_sim._create_synthetic_workpiece(is_good=True)
                    frame = cv2.cvtColor(np.array(mock_img), cv2.COLOR_RGB2BGR)

                with self.lock:
                    self.latest_frame = frame
                    ret_enc, jpeg = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                    if ret_enc:
                        self.latest_frame_jpeg = jpeg.tobytes()
                time.sleep(0.08)  # ~12 FPS simulation stream

    def freeze_alarm_frame(self, jpeg_bytes: Optional[bytes] = None):
        """Freezes camera stream to display defective NG workpiece with red box during alarm."""
        with self.lock:
            self.is_alarm_frozen = True
            if jpeg_bytes:
                self.latest_frame_jpeg = jpeg_bytes
                nparr = np.frombuffer(jpeg_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is not None:
                    self.latest_frame = frame
            else:
                ng_candidates = []
                for folder in [config.SAMPLE_IMAGES_DIR / "ng", Path("รูปงาน NG"), config.SAMPLE_IMAGES_DIR]:
                    if folder.exists():
                        for ext in ("*.png", "*.jpg", "*.jpeg"):
                            ng_candidates.extend(folder.glob(ext))
                ng_candidates = [
                    p for p in ng_candidates
                    if ("ng" in str(p.parent.name).lower() or p.stem.lower().startswith("real_ng") or p.stem.lower().startswith("sample_ng"))
                    and p.is_file()
                ]
                sample_ng = ng_candidates[0] if ng_candidates else (config.SAMPLE_IMAGES_DIR / "sample_ng.jpg")
                if sample_ng and sample_ng.exists():
                    try:
                        pil_im = Image.open(str(sample_ng)).convert("RGB")
                        self.latest_frame = cv2.cvtColor(np.array(pil_im), cv2.COLOR_RGB2BGR)
                        ret_enc, jpeg = cv2.imencode('.jpg', self.latest_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                        if ret_enc:
                            self.latest_frame_jpeg = jpeg.tobytes()
                    except Exception as e:
                        print(f"[CameraService] Error loading NG sample: {e}")

    def clear_alarm_frame(self):
        """Unfreezes alarm frame and resumes live camera stream / good baseline."""
        with self.lock:
            self.is_alarm_frozen = False
            self.hold_until = 0.0

    def update_from_cira_base64(self, base64_str: str, is_ng: bool = False):
        """Updates latest frame when CiRA CORE delivers an inspection image via MQTT."""
        try:
            img_bytes = base64.b64decode(base64_str)
            nparr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if frame is not None:
                with self.lock:
                    self.latest_frame = frame
                    self.latest_frame_jpeg = img_bytes
                    if is_ng:
                        self.is_alarm_frozen = True
                    else:
                        # Hold Good workpiece result image for 4.0 seconds so operator sees inspection clearly!
                        self.hold_until = time.time() + 4.0
        except Exception as e:
            print(f"[CameraService] Error updating from base64: {e}")

    def get_latest_jpeg(self) -> Optional[bytes]:
        with self.lock:
            return self.latest_frame_jpeg

    def capture_snapshot(self) -> Tuple[Optional[np.ndarray], Optional[str]]:
        """
        Captures a still frame and encodes to Base64.
        Returns (frame_cv2, base64_str)
        """
        with self.lock:
            if self.latest_frame is not None:
                frame_copy = self.latest_frame.copy()
            else:
                # Generate synthetic
                mock_img = cira_sim._create_synthetic_workpiece(is_good=True)
                frame_copy = cv2.cvtColor(np.array(mock_img), cv2.COLOR_RGB2BGR)

        ret_enc, jpeg = cv2.imencode('.jpg', frame_copy, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        if ret_enc:
            b64_str = base64.b64encode(jpeg.tobytes()).decode('utf-8')
            return frame_copy, b64_str
        return None, None

# Global instance
camera_service = CameraService()

