"""
Application Configuration for CiRA Image AI Workpiece Packing Inspection System
บริษัท มูราตะ อิเล็กทรอนิกส์ (ประเทศไทย) จำกัด - DX12
"""

import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent

# Load local environment variables from .env if present
_env_file = BASE_DIR / ".env"
if _env_file.exists():
    try:
        with open(_env_file, "r", encoding="utf-8") as _f:
            for _line in _f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    os.environ.setdefault(_k.strip(), _v.strip().strip("'\""))
    except Exception:
        pass
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "traceability.db"
INSPECTIONS_DIR = DATA_DIR / "inspections"
SAMPLE_IMAGES_DIR = DATA_DIR / "sample_images"

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)
INSPECTIONS_DIR.mkdir(exist_ok=True)
SAMPLE_IMAGES_DIR.mkdir(exist_ok=True)

# System Operational Parameters (Poka-Yoke)
BOX_START_DELAY_SEC = 3.0     # Delay 3s before opening camera feed when lot starts
MOTION_BLUR_DELAY_SEC = 2.0   # Delay 2s to check G/NG (Poka-Yoke motion blur prevention)
RESULT_HOLD_TIME_SEC = 3.0    # Hold G/NG result & Tower Lamp for 3s before auto-saving
DUMMY_SAMPLE_REQUIRED = True # Bypass Dummy Test requirement

# Server Settings
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 9999))
DEBUG = True

# Operational Mode
# Set to False when deploying to physical workstation with real USB-to-RS485 and Relay Board
SIMULATION_MODE = True

# Modbus RTU Relay Board Settings (4-Channel Industrial Relay over RS485)
MODBUS_SERIAL_PORT = "COM3"    # Default USB-to-RS485 port on Mini PC
MODBUS_BAUDRATE = 9600
MODBUS_BYTESIZE = 8
MODBUS_PARITY = 'N'
MODBUS_STOPBITS = 1
MODBUS_SLAVE_ID = 1
MODBUS_TIMEOUT_SEC = 0.5

# Relay Channel Mapping
RELAY_CH_GREEN = 1             # Channel 1: Tower Lamp Green (Good: G)
RELAY_CH_RED = 2               # Channel 2: Tower Lamp Red (Not Good: NG)
RELAY_CH_YELLOW = 3            # Channel 3: Tower Lamp Yellow (Standby / Testing)
RELAY_CH_BUZZER = 4            # Channel 4: 24V DC Buzzer (Alarm)

# MQTT Broker Settings
MQTT_BROKER_HOST = "localhost"
MQTT_BROKER_PORT = 1883
MQTT_CLIENT_ID = "Murata_Packing_Inspection_Controller"
MQTT_KEEPALIVE = 60

# MQTT Topics (CiRA CORE & System Communication)
TOPIC_BARCODE = "/cira/barcode"           # Barcode scan string
TOPIC_CAMERA_TRIGGER = "/cira/trigger"    # Trigger CiRA camera capture
TOPIC_INSPECTION_RESULT = "/cira/result"  # CiRA result payload {status, confidence, image_base64}
TOPIC_SYSTEM_STATE = "/cira/status"       # System state broadcast
TOPIC_ALARM_CONTROL = "/cira/alarm"       # Manual or automated alarm control

# Default Production Presets
SYSTEM_PIN = "123456"  # 6-digit PIN to access system
DEFAULT_OPERATOR_ID = "MTL80343"
DEFAULT_OPERATOR_NAME = "Aun"
DEFAULT_PART_MODEL = "E2E35A222MA387012F+M01/B"
DEFAULT_TARGET_BOXES = 3       # 3 boxes per lot
DEFAULT_QTY_PER_BOX = 700      # ~700 pieces per box
SUPPORTED_PART_MODELS = [
    "MURATA-IND-405 (Power Inductor)",
    "MURATA-FLTR-102 (Filter Array)",
    "MURATA-CAP-808 (MLCC Capacitor)",
    "MURATA-RES-912 (Precision Resistor)"
]

# Supervisor / Leader Authorization Passcodes for Bypass (for demo/production fallback)
AUTHORIZED_LEADER_IDS = ["LEADER-01", "LEADER-99", "DX12-ADMIN", "SUPERVISOR", "MTL80343"]

# Supabase Cloud Database & Storage Configuration
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://sfcqupczobtbrpnqfuxn.supabase.co")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_rCOPX9KKii1X6u4Qf_bAmA_Q2fQJcVs")
SUPABASE_SECRET_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
SUPABASE_ENABLED = os.environ.get("SUPABASE_ENABLED", "True").lower() in ("true", "1", "yes")
SUPABASE_BUCKET_NAME = os.environ.get("SUPABASE_BUCKET_NAME", "inspection-evidence")


