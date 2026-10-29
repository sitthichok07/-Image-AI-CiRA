"""
Modbus RTU 4-Channel Industrial Relay Controller Driver
Connects via USB-to-RS485 adapter (A+ and B-) to control Tower Lamp and Buzzer
Includes Hardware Serial Communication + Virtual Mock Simulation Driver
"""

import time
import threading
from typing import Dict, Optional, Callable, List
import config

def calc_crc16(data: bytes) -> bytes:
    """Calculates Modbus RTU CRC16."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc.to_bytes(2, byteorder='little')

class ModbusRelayController:
    """
    Controller for 4-Channel Industrial Relay Board over Modbus RTU / RS485.
    Channels:
      1: Green Tower Lamp (Good: G)
      2: Red Tower Lamp (Not Good: NG)
      3: Yellow Tower Lamp (Standby / Testing)
      4: 24V DC Buzzer (Alarm)
    """

    def __init__(
        self,
        port: str = config.MODBUS_SERIAL_PORT,
        baudrate: int = config.MODBUS_BAUDRATE,
        slave_id: int = config.MODBUS_SLAVE_ID,
        simulation: bool = config.SIMULATION_MODE
    ):
        self.port = port
        self.baudrate = baudrate
        self.slave_id = slave_id
        self.simulation = simulation
        self.serial_conn = None
        self.relay_states = {1: False, 2: False, 3: True, 4: False}
        self.callbacks: List[Callable[[Dict[int, bool]], None]] = []
        self._timer_lock = threading.Lock()
        self._off_timer: Optional[threading.Timer] = None

        if not self.simulation:
            self._init_serial()

    def _init_serial(self):
        """Attempts to open real serial port via pyserial."""
        try:
            import serial
            self.serial_conn = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=config.MODBUS_BYTESIZE,
                parity=config.MODBUS_PARITY,
                stopbits=config.MODBUS_STOPBITS,
                timeout=config.MODBUS_TIMEOUT_SEC
            )
            print(f"[ModbusRelay] Connected to hardware port {self.port} at {self.baudrate} baud.")
        except Exception as e:
            print(f"[ModbusRelay] Warning: Could not open serial port {self.port} ({e}). Falling back to simulation.")
            self.simulation = True
            self.serial_conn = None

    def register_callback(self, cb: Callable[[Dict[int, bool]], None]):
        """Registers a listener callback for relay state changes (e.g. for WebSocket UI)."""
        if cb not in self.callbacks:
            self.callbacks.append(cb)

    def _notify(self):
        for cb in self.callbacks:
            try:
                cb(dict(self.relay_states))
            except Exception as e:
                print(f"[ModbusRelay] Callback error: {e}")

    def _build_write_coil_frame(self, channel: int, state: bool) -> bytes:
        """
        Builds Modbus RTU Function Code 0x05 (Write Single Coil).
        Coil addresses 0x0000 to 0x0003 for channels 1 to 4.
        Value: 0xFF00 for ON, 0x0000 for OFF.
        """
        addr = channel - 1
        val_hi = 0xFF if state else 0x00
        val_lo = 0x00
        frame_head = bytes([self.slave_id, 0x05, 0x00, addr, val_hi, val_lo])
        crc = calc_crc16(frame_head)
        return frame_head + crc

    def set_relay(self, channel: int, state: bool):
        """Sets individual relay channel (1-4) ON or OFF."""
        if channel not in [1, 2, 3, 4]:
            raise ValueError(f"Invalid relay channel {channel}, must be 1-4")

        self.relay_states[channel] = bool(state)

        if not self.simulation and self.serial_conn and self.serial_conn.is_open:
            try:
                cmd = self._build_write_coil_frame(channel, state)
                self.serial_conn.write(cmd)
                self.serial_conn.flush()
                # Read response echo
                time.sleep(0.05)
                _ = self.serial_conn.read(8)
            except Exception as e:
                print(f"[ModbusRelay] Serial write error: {e}")

        # Always notify state change
        self._notify()

    def set_all(self, states: Dict[int, bool]):
        for ch, st in states.items():
            self.set_relay(ch, st)

    def turn_all_off(self):
        """Turns off all relays."""
        with self._timer_lock:
            if self._off_timer and self._off_timer.is_alive():
                self._off_timer.cancel()
        for ch in [1, 2, 3, 4]:
            self.set_relay(ch, False)

    # ---------------- Application Specific Sequences ----------------

    def trigger_good_result(self, duration_sec: float = config.RESULT_HOLD_TIME_SEC):
        """
        Action for Good (G):
        - Turn ON Tower Lamp Green (Ch 1)
        - Ensure Red (Ch 2) & Buzzer (Ch 4) are OFF
        - After duration_sec (default 3s), turn Green OFF
        """
        with self._timer_lock:
            if self._off_timer and self._off_timer.is_alive():
                self._off_timer.cancel()

        self.set_relay(config.RELAY_CH_RED, False)
        self.set_relay(config.RELAY_CH_BUZZER, False)
        self.set_relay(config.RELAY_CH_YELLOW, False)
        self.set_relay(config.RELAY_CH_GREEN, True)

        def _turn_green_off():
            self.set_relay(config.RELAY_CH_GREEN, False)
            self.set_relay(config.RELAY_CH_YELLOW, True)

        with self._timer_lock:
            self._off_timer = threading.Timer(duration_sec, _turn_green_off)
            self._off_timer.daemon = True
            self._off_timer.start()

    def trigger_ng_alarm(self):
        """
        Action for Not Good (NG):
        - Turn ON Tower Lamp Red (Ch 2)
        - Turn ON Buzzer (Ch 4)
        - Turn OFF Green (Ch 1) & Yellow (Ch 3)
        - Alarm stays active until explicitly cleared or bypassed
        """
        with self._timer_lock:
            if self._off_timer and self._off_timer.is_alive():
                self._off_timer.cancel()

        self.set_relay(config.RELAY_CH_GREEN, False)
        self.set_relay(config.RELAY_CH_YELLOW, False)
        self.set_relay(config.RELAY_CH_RED, True)
        self.set_relay(config.RELAY_CH_BUZZER, True)

    def trigger_standby(self):
        """Sets system to standby state (Yellow light ON or all off)."""
        with self._timer_lock:
            if self._off_timer and self._off_timer.is_alive():
                self._off_timer.cancel()
        self.set_relay(config.RELAY_CH_RED, False)
        self.set_relay(config.RELAY_CH_BUZZER, False)
        self.set_relay(config.RELAY_CH_GREEN, False)
        self.set_relay(config.RELAY_CH_YELLOW, True)

    def clear_alarm(self):
        """Clears Red light and Buzzer alarm and restores Yellow standby."""
        self.set_relay(config.RELAY_CH_RED, False)
        self.set_relay(config.RELAY_CH_BUZZER, False)
        self.set_relay(config.RELAY_CH_GREEN, False)
        self.set_relay(config.RELAY_CH_YELLOW, True)

    def get_status(self) -> Dict[str, Any]:
        return {
            "simulation": self.simulation,
            "port": self.port,
            "connected": bool(self.serial_conn and self.serial_conn.is_open) if not self.simulation else False,
            "relays": {
                "green": self.relay_states[config.RELAY_CH_GREEN],
                "red": self.relay_states[config.RELAY_CH_RED],
                "yellow": self.relay_states[config.RELAY_CH_YELLOW],
                "buzzer": self.relay_states[config.RELAY_CH_BUZZER]
            }
        }

# Global Singleton Instance
relay_controller = ModbusRelayController()
