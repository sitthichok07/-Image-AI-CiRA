# คู่มือการตั้งค่าโหนดบนแพลตฟอร์ม CiRA CORE (CiRA Workflow Guide)
**โครงงานสหกิจศึกษา: ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA**  
**บริษัท มูราตะ อิเล็กทรอนิกส์ (ประเทศไทย) จำกัด แผนก Digital & Data Utilization Promotion Section (DX12)**

---

## 1. ผังการเชื่อมต่อโหนดใน CiRA CORE (Node Flow Pipeline)

บนโปรแกรม CiRA CORE ให้สร้างโฟลว์การทำงานเชื่อมต่อบล็อกโหนดตามลำดับดังนี้:

```
[Auto Run] 
    │
    ▼
[Mqtt Sub] (Topic: /cira/trigger)
    │
    ▼
[Delay (MS)] (2000 ms - Poka-Yoke Motion Blur Prevention)
    │
    ▼
[Web Cam] (USB Camera 1080p, Device Index: 0)
    │
    ├──► [Image Capture] (บันทึกภาพลงเครื่องเพื่อตรวจสอบ / ทำ Dataset)
    │
    ▼
[Deep Detect] (โมเดล Deep Learning แยก G และ NG)
    │
    ├──► [Debug] (แสดงภาพและ Bounding Box บนหน้าจอ CiRA)
    │
    ├──► [Mqtt Pub] (Topic: /cira/result - ส่ง Payload ผลตรวจ {status, confidence})
    │
    └──► [MqttimagePub] (ส่งภาพถ่ายแบบ Base64 Payload กลับไปยัง Web Dashboard)
```

---

## 2. รายละเอียดและการกำหนดค่าพารามิเตอร์ของแต่ละโหนด (ตามตาราง 2.1 และ 2.2 ในเล่มรายงาน)

| ลำดับ | ชื่อโหนด | หน้าที่การทำงาน | ค่าพารามิเตอร์ที่ต้องกำหนด (Configuration) |
|---|---|---|---|
| **1** | **Auto Run** | จุดเริ่มต้นการทำงานอัตโนมัติเมื่อเปิดโปรแกรม | - Enable on Start: `True` |
| **2** | **Mqtt Sub** | ดักรับสัญญาณ Trigger เมื่อสแกนบาร์โค้ด | - Broker: `127.0.0.1` (Port: `1883`)<br>- Topic: `/cira/trigger` |
| **3** | **Delay (MS)** | หน่วงเวลา 2 วินาทีให้กล่องหยุดนิ่งสนิท | - Delay Time: `2000` ms (ป้องกันภาพเบลอจาก Motion Blur) |
| **4** | **Web Cam** | ดึงภาพเคลื่อนไหวจากกล้องเว็บแคม | - Resolution: `1920x1080` หรือ `1280x720`<br>- Frame Rate: `30 fps` |
| **5** | **Deep Detect** | รันโมเดล Deep Learning จำแนกทิศทางชิ้นงาน | - Model Path: โมเดลที่เทรนด้วย CiRA Train<br>- Classes: `G` (งานถูกต้อง), `NG` (งานกลับด้านมีเทป)<br>- Confidence Threshold: `0.85` |
| **6** | **Mqtt Pub** | ส่งผลการตัดสิน (G/NG) และค่าความเชื่อมั่น | - Topic: `/cira/result`<br>- QoS: `0` หรือ `1` |
| **7** | **MqttimagePub** | แปลงภาพถ่ายผลการตรวจเป็นรหัส Base64 ส่งผ่าน MQTT | - Topic: `/cira/result`<br>- Format: `JPEG`<br>- Encoding: `Base64` |
| **8** | **Debug** | มอนิเตอร์ดูภาพผลลัพธ์บนโปรแกรม CiRA CORE | - Show Bounding Box & Class Name: `True` |

---

## 3. รูปแบบข้อความ Payload ที่ส่งหากันผ่าน MQTT (Data Contract)

### 3.1 ข้อความสั่งทริกเกอร์เปิดกล้อง (จาก Web Dashboard -> CiRA CORE)
- **Topic:** `/cira/trigger`
- **Payload (JSON):**
```json
{
  "command": "TRIGGER_INSPECTION",
  "box_barcode": "BX-20261019-001",
  "timestamp": 1729310000.0
}
```

### 3.2 ข้อความส่งผลตรวจและรูปภาพ (จาก CiRA CORE -> Web Dashboard)
- **Topic:** `/cira/result`
- **Payload (JSON หรือ HTTP Webhook):**
```json
{
  "status": "SUCCESS",
  "result": "G",
  "confidence": 99.25,
  "box_barcode": "BX-20261019-001",
  "image_base64": "/9j/4AAQSkZJRgABAQAAAQABAAD...",
  "timestamp": "2026-10-19T10:15:00"
}
```
*(หมายเหตุ: หากเป็นชิ้นงานผิดพลาด ค่า `"result"` จะเป็น `"NG"`)*
