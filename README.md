# ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA
### CiRA Image AI-based Workpiece Packing Inspection System
**บริษัท มูราตะ อิเล็กทรอนิกส์ (ประเทศไทย) จำกัด แผนก Digital & Data Utilization Promotion Section (DX12)**  
หลักสูตรวิศวกรรมอิเล็กทรอนิกส์และระบบควบคุมอัตโนมัติ คณะวิศวกรรมศาสตร์ มหาวิทยาลัยเทคโนโลยีราชมงคลลานนา

---

## 🌟 จุดเด่นและความสามารถของระบบ (Key Features)

1. **หน้าจอเว็บแดชบอร์ดแสดงผลสด (Live Real-Time Web HMI)**:
   - เปิดดูผลการตรวจจับได้ทันทีผ่านเว็บเบราว์เซอร์ (`http://localhost:8000`)
   - รองรับการแสดงผลทั้งบนคอมพิวเตอร์และหน้าจอสัมผัส **Waveshare 10.1" Touch Display**
   - แสดงภาพถ่ายชิ้นงานแบบเรียลไทม์ พร้อมแบนเนอร์แสดงสถานะขนาดใหญ่:
     - **งานถูกต้อง (GOOD : G)** พร้อมคะแนนความเชื่อมั่น (Confidence Score ~99%)
     - **งานผิดพลาด (NOT GOOD : NG)** แจ้งเตือนข้อผิดพลาด (ใส่กลับด้าน / มีเทป)
2. **กลไก Poka-Yoke หน่วงเวลา 2 วินาที (Motion Blur Prevention)**:
   - เมื่อสแกนบาร์โค้ดกล่อง ระบบจะหน่วงเวลานับถอยหลัง 2 วินาทีบนหน้าจอ เพื่อรอให้กล่องบนแท่นสไลด์หยุดนิ่งสนิทก่อนสั่งกล้องจับภาพ แก้ปัญหาภาพเบลอจากการสไลด์กล่องเร็วเกินไป
3. **การขับสัญญาณเตือนฮาร์ดแวร์อุตสาหกรรม (Industrial Tower Lamp & 24V Buzzer)**:
   - ควบคุมบอร์ดรีเลย์ 4 ช่อง ผ่าน **Modbus RTU over RS485**:
     - **ชิ้นงานถูกต้อง (G)**: เปิดไฟ Tower Lamp สีเขียวค้างไว้ 3 วินาที
     - **ชิ้นงานผิดพลาด (NG)**: เปิดไฟ Tower Lamp สีแดง พร้อมเปิดเสียงเตือน Buzzer 24V ทันที
   - มี **Virtual Hardware Panel** จำลองไฟ 3 สีและสังเคราะห์เสียง Buzzer ในเว็บเบราว์เซอร์ สำหรับทดสอบได้ทันทีแม้ยังไม่ได้ต่ออุปกรณ์จริง
4. **ฟังก์ชันอนุมัติข้ามกล่องงานโดยหัวหน้างาน (Leader Bypass)**:
   - เมื่อเกิดข้อผิดพลาด (NG) ระบบจะล็อกการทำงาน พนักงานไม่สามารถปล่อยผ่านได้
   - กำหนดให้หัวหน้างาน (Leader/Supervisor) สแกนหรือใส่รหัสพนักงานหน้างานเพื่อยืนยันสิทธิ์ ระบบจึงจะปลดล็อกและเปลี่ยนสถานะเป็น G พร้อมบันทึกประวัติการอนุมัติ
5. **ระบบตรวจสอบย้อนกลับ (Traceability & SQL Database)**:
   - ถอดรหัส Base64 ภาพถ่ายจาก CiRA CORE บันทึกเป็นไฟล์ภาพหลักฐานความละเอียดสูง
   - บันทึกประวัติทุกล็อตและทุกกล่องงานลงฐานข้อมูล SQLite (สามารถดูภาพย้อนหลัง ค้นหา และส่งออกรายงานเป็น CSV ได้ทันที)
6. **ระบบทดสอบความพร้อมก่อนเริ่มงาน (Dummy Test)**:
   - บังคับให้พนักงานทำการทดสอบด้วยชิ้นงานตัวอย่าง Good และ NG ให้ผ่านก่อนเริ่มผลิตในแต่ละกะ

---

## 🚀 วิธีการเปิดใช้งานระบบ (Quick Start)

### วิธีที่ 1: ดับเบิลคลิกไฟล์ Run
- ดับเบิลคลิกที่ไฟล์ **`run.bat`**
- ระบบจะเปิดเซิร์ฟเวอร์และเปิดหน้าจอเว็บเบราว์เซอร์ที่ `http://localhost:8000` ให้อัตโนมัติ

### วิธีที่ 2: รันคำสั่งผ่าน Terminal / PowerShell
```powershell
cd "c:\Aun\ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA"
py run_system.py
```

---

## 📁 โครงสร้างโปรเจกต์ (Project Structure)

```
ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA/
├── config.py                     # การตั้งค่าระบบ (Delay, Modbus, MQTT, Relays)
├── run_system.py                 # ตัวเปิดเซิร์ฟเวอร์หลัก (FastAPI + WebSockets + Video Stream)
├── run.bat                       # สคริปต์คลิกเปิดระบบสำหรับพนักงาน
├── backend/
│   ├── database.py               # ฐานข้อมูล SQLite Traceability & Summary
│   ├── modbus_relay.py           # ไดรเวอร์ Modbus RTU คุม Relay 4 ช่อง & Tower Lamp
│   ├── camera_service.py         # บริการดึงภาพกล้องเว็บแคม / MJPEG Video Stream
│   ├── mqtt_service.py           # สื่อสารรับส่งข้อมูล MQTT กับ CiRA CORE
│   ├── cira_simulator.py         # ตัวจำลองโมเดล AI และสร้างภาพตัวอย่างตามบทที่ 4
│   └── controller.py             # ตรรกะควบคุมกระบวนการ (State Machine & Poka-Yoke)
├── frontend/
│   ├── templates/
│   │   └── index.html            # หน้าจอเว็บแดชบอร์ดหลัก (Touch HMI)
│   └── static/
│       ├── css/style.css         # ธีม Industrial Dark Mode สำหรับจอ 10.1 นิ้ว
│       └── js/
│           ├── app.js            # ตรรกะหน้าจอเว็บ, WebSockets, และบันทึกประวัติ
│           └── virtual_hw.js     # จำลองไฟ Tower Lamp และสังเคราะห์เสียง Buzzer
├── data/
│   ├── sample_images/            # ภาพตัวอย่างชิ้นงานดี / เสีย
│   ├── inspections/              # โฟลเดอร์เก็บรูปถ่ายผลการตรวจจริง
│   └── traceability.db           # ไฟล์ฐานข้อมูล
├── cira_nodes/
│   └── cira_workflow_guide.md    # คู่มือการตั้งค่าโหนดบน CiRA CORE
└── tests/
    └── test_system.py            # Automated Unit Tests ทดสอบทุกโมดูล
```

---

## 🔌 การต่อสายฮาร์ดแวร์จริงหน้างาน (Hardware Wiring)

อ้างอิงจากแผนผังหน้า 29 ในเล่มรายงาน:
1. **ตัวแปลง USB-to-RS485** เสียบเข้าพอร์ต USB ของ Mini PC:
   - สายสีเขียว **A+** ต่อเข้าช่อง A+ ของบอร์ดรีเลย์ 4 ช่อง
   - สายสีเหลือง **B-** ต่อเข้าช่อง B- ของบอร์ดรีเลย์ 4 ช่อง
2. **บอร์ดรีเลย์ 4 ช่อง (24V DC)**:
   - **Ch 1 (COM-NO)**: ควบคุมไฟสีเขียว (Tower Lamp Green)
   - **Ch 2 (COM-NO)**: ควบคุมไฟสีแดง (Tower Lamp Red)
   - **Ch 3 (COM-NO)**: ควบคุมไฟสีเหลือง (Tower Lamp Yellow)
   - **Ch 4 (COM-NO)**: ควบคุมเสียงบัซเซอร์ (24V DC Buzzer + 20kΩ Potentiometer)
3. **การสลับโหมดฮาร์ดแวร์จริง**:
   - ในไฟล์ `config.py` ให้ปรับค่า:
     ```python
     SIMULATION_MODE = False
     MODBUS_SERIAL_PORT = "COM3"  # ตรวจสอบหมายเลข COM Port ใน Device Manager
     ```

---

## 📡 การเชื่อมต่อกับ CiRA CORE ผ่าน MQTT

- **Topic คำสั่งเปิดกล้อง (Dashboard -> CiRA)**: `/cira/trigger`
- **Topic ส่งผลตรวจและภาพ (CiRA -> Dashboard)**: `/cira/result`
  - Payload รูปแบบ JSON:
    ```json
    {
      "result": "G",
      "confidence": 99.20,
      "box_barcode": "BX-001",
      "image_base64": "<รหัส Base64 ของรูปภาพ JPEG>"
    }
    ```
- หรือส่งผ่าน **HTTP POST Webhook** มาที่: `http://localhost:8000/api/cira/result` ได้โดยตรง
# -Image-AI-CiRA
