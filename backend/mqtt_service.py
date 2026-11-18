"""
MQTT Service & Event Bus Bridge
Handles MQTT Pub/Sub with CiRA CORE platform and provides internal event dispatching
Supports external MQTT broker (e.g. Mosquitto) or internal Fallback EventBus
"""

import json
import threading
import time
from typing import Callable, Dict, Any, List, Optional
import config

class MQTTService:
    def __init__(self):
        self.connected = False
        self.client = None
        self.listeners: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {}
        self._lock = threading.Lock()

        # Attempt to initialize Paho MQTT client
        self._init_paho()

    def _init_paho(self):
        try:
            import paho.mqtt.client as mqtt
            self.client = mqtt.Client(client_id=config.MQTT_CLIENT_ID)
            self.client.on_connect = self._on_connect
            self.client.on_message = self._on_message
            self.client.on_disconnect = self._on_disconnect

            # Connect in a background thread to prevent blocking if broker not present
            threading.Thread(target=self._connect_broker, daemon=True).start()
        except ImportError:
            print("[MQTTService] paho-mqtt not installed. Using Internal EventBus mode.")
            self.connected = False
        except Exception as e:
            print(f"[MQTTService] Init error: {e}")
            self.connected = False

    def _connect_broker(self):
        try:
            self.client.connect(config.MQTT_BROKER_HOST, config.MQTT_BROKER_PORT, config.MQTT_KEEPALIVE)
            self.client.loop_start()
            self.connected = True
            print(f"[MQTTService] Connected to MQTT broker at {config.MQTT_BROKER_HOST}:{config.MQTT_BROKER_PORT}")
        except Exception as e:
            print(f"[MQTTService] Notice: External MQTT broker not reachable ({e}). System operating in EventBus mode.")
            self.connected = False

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self.connected = True
            # Subscribe to topics
            client.subscribe(config.TOPIC_BARCODE)
            client.subscribe(config.TOPIC_INSPECTION_RESULT)
            client.subscribe(config.TOPIC_ALARM_CONTROL)
            print(f"[MQTTService] Subscribed to CiRA topics: {config.TOPIC_INSPECTION_RESULT}, {config.TOPIC_BARCODE}")
        else:
            self.connected = False

    def _on_disconnect(self, client, userdata, rc):
        self.connected = False

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        payload_str = msg.payload.decode('utf-8', errors='ignore')
        try:
            data = json.loads(payload_str)
        except Exception:
            data = {"raw": payload_str}

        self.dispatch(topic, data)

    def subscribe(self, topic: str, callback: Callable[[Dict[str, Any]], None]):
        """Registers a listener for a specific topic."""
        with self._lock:
            if topic not in self.listeners:
                self.listeners[topic] = []
            self.listeners[topic].append(callback)

    def dispatch(self, topic: str, data: Dict[str, Any]):
        """Dispatches event to all registered listeners."""
        with self._lock:
            callbacks = list(self.listeners.get(topic, []))
            # Also notify wildcard listeners if any
            wildcard = list(self.listeners.get("*", []))

        for cb in callbacks + wildcard:
            try:
                cb(data)
            except Exception as e:
                print(f"[MQTTService] Listener callback error on {topic}: {e}")

    def publish(self, topic: str, payload: Any):
        """Publishes to MQTT broker if available and dispatches locally."""
        payload_dict = payload if isinstance(payload, dict) else {"payload": payload}
        payload_str = json.dumps(payload_dict)

        if self.connected and self.client:
            try:
                self.client.publish(topic, payload_str)
            except Exception as e:
                print(f"[MQTTService] Publish error to broker: {e}")

        # Always dispatch locally to internal listeners
        self.dispatch(topic, payload_dict)

    def trigger_cira_camera(self, box_barcode: str):
        """Sends command to CiRA CORE to capture and inspect."""
        payload = {
            "command": "TRIGGER_INSPECTION",
            "box_barcode": box_barcode,
            "timestamp": time.time()
        }
        self.publish(config.TOPIC_CAMERA_TRIGGER, payload)

# Global Singleton Instance
mqtt_service = MQTTService()
