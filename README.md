# 🎙️ Meeting Audio Transcriber (Whisper API & Hermes-Agent)

ส่วนขยาย Google Chrome (Manifest V3) สำหรับดักจับเสียงการประชุมจากแท็บ (Google Meet, Microsoft Teams, Zoom บนเว็บ) พร้อมบันทึกเสียงไมโครโฟนของคุณเอง (Mix Tab + Mic) ส่งแปลงเป็นข้อความด้วย **Whisper API (Groq / OpenAI)** และส่งต่อเข้า **Hermes-Agent Webhook** อัตโนมัติ

---

## ✨ ฟีเจอร์เด่น (Key Features)

1. **Manifest V3 Compliant & Offscreen Recording**:
   - ใช้ Chrome Offscreen Document ในการบันทึกเสียงต่อเนื่อง ไม่โดนจำกัดอายุ Service Worker
2. **Audio Mixing (เสียงเพื่อนในห้องประชุม + เสียงไมค์ตัวเอง)**:
   - ดักเสียงคนอื่นจากแท็บผ่าน `chrome.tabCapture` และเปิดเสียงวนออกลำโพง/หูฟังตามปกติ (คุณยังได้ยินเพื่อนคุย)
   - รวมเสียงไมค์ของคุณเองเข้าด้วยกัน โดยไม่สะท้อนกลับเข้าหู (No Echo Feedback)
3. **Standalone WebM Chunking (แก้ไขบั๊กยอดฮิตของ Whisper)**:
   - บันทึกตัดชิ้นไฟล์เสียงแยก Container หัวไฟล์ WebM/EBML ทุกก้อน (Default 30 วินาที) ทำให้ Whisper API ถอดเสียงได้ 100% ไม่มีปัญหา Header Error
4. **รองรับ Whisper API ชั้นนำ**:
   - **Groq Whisper** (`whisper-large-v3`): แนะนำเป็นพิเศษ แปลงเสียงเร็วระดับ 0.5 วินาทีต่อก้อน และฟรี/ราคาประหยัดมาก
   - **OpenAI Whisper** (`whisper-1`)
   - **Custom / Self-hosted Whisper API** (เช่น Faster-Whisper, Whisper.cpp)
5. **เชื่อมต่อกับ Hermes-Agent**:
   - รองรับการยิง HTTP POST Webhook พร้อม `X-API-KEY`
   - เลือกได้ทั้งส่งสรุปเมื่อจบการประชุม (Meeting Summary) หรือส่ง Realtime Chunk ทันทีที่ถอดความเสร็จ
6. **UI ทันสมัย (Dark Theme)**:
   - มี VU Meter / Soundwave ตรวจจับระดับเสียงสด
   - หน้าต่างแสดงข้อความถอดเสียงแบบ Realtime พร้อมปุ่มคัดลอก (Copy All)
   - ตัวจับเวลาการประชุม (Meeting Timer)

---

## 📁 โครงสร้างโปรเจกต์ (Project Structure)

```
transcription/
├── manifest.json       # ไฟล์การตั้งค่า Extension (Manifest V3)
├── popup.html          # หน้าต่าง UI หลักของ Extension
├── popup.css           # สไตล์ Dark Theme สวยงามทันสมัย
├── popup.js            # ตรรกะควบคุมหน้าต่าง ปรับตั้งค่า และสั่งงาน
├── offscreen.html      # หน้าเอกสารเบื้องหลังสำหรับรัน Audio Stream
├── offscreen.js        # ตัวดักจับเสียงแท็บ ผสมไมค์ และอัด Chunking
├── background.js       # Service Worker จัดการ API Whisper และ Hermes
├── icons/              # ไอคอนความละเอียด 16x16, 48x48, 128x128
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── task.md             # สเปกงานเริ่มต้น
└── README.md           # คู่มือการติดตั้งและใช้งาน
```

---

## 🛠️ วิธีติดตั้งและใช้งานใน Google Chrome

### ขั้นตอนที่ 1: ติดตั้ง Extension
1. เปิดเบราว์เซอร์ **Google Chrome**
2. พิมพ์ในช่อง Address bar: `chrome://extensions` แล้วกด Enter
3. เปิดสวิตช์ **Developer mode** (โหมดนักพัฒนา) ที่มุมบนขวา
4. กดปุ่ม **Load unpacked** (โหลดส่วนขยายที่ยังไม่แพ็ก) ที่มุมบนซ้าย
5. เลือกโฟลเดอร์โปรเจกต์นี้:
   ```
   /Users/suchat/Projects/Tong/transcription
   ```
6. ส่วนขยาย **Meeting Audio Transcriber (Whisper & Hermes)** จะปรากฏขึ้นมาพร้อมใช้งานทันที

---

### ขั้นตอนที่ 2: ตั้งค่า API Key & Hermes Webhook
1. คลิกที่ไอคอนของ Extension บนแถบเครื่องมือของ Chrome
2. สลับไปที่แท็บ **"ตั้งค่า" (Settings)**
3. กรอกข้อมูล:
   - **Speech-to-Text Provider**: เลือก **Groq Whisper** (แนะนำ) หรือ **OpenAI**
   - **STT API Key**: ใส่ API Key ของคุณ (เช่น `gsk_...` ของ Groq จาก [console.groq.com](https://console.groq.com))
   - **ภาษา**: เลือก `ไทย (th)` หรือ `English (en)`
   - **Hermes Webhook URL**: ใส่ URL Endpoint ของ hermes-agent (เช่น `https://your-hermes-domain.com/api/webhook/meeting`)
   - **Hermes Secret Token**: ใส่คีย์ความลับสำหรับ Header `X-API-KEY`
4. กดปุ่ม **"บันทึกการตั้งค่า"**

---

### ขั้นตอนที่ 3: เริ่มใช้งานขณะประชุม (Google Meet / Teams)
1. เปิดแท็บการประชุม เช่น **Google Meet** หรือ **Teams Web**
2. คลิกเปิด Extension Popup
3. กดปุ่ม **"เริ่มดักจับเสียง & แปลงข้อความ"**
   - ในครั้งแรก Chrome อาจมีป๊อปอัปขอสิทธิ์ใช้ไมโครโฟน ให้กด **Allow (อนุญาต)**
4. เมื่อเริ่มอัด:
   - สเตตัสจะเปลี่ยนเป็นสีแดงพร้อมแถบคลื่นเสียงขยับตามการพูด
   - ข้อความที่คนในที่ประชุมและตัวคุณพูดจะทยอยแสดงผลในกล่องข้อความทุกๆ 30 วินาที
5. เมื่อประชุมเสร็จ:
   - กดปุ่ม **"หยุดดักจับเสียง & แปลงข้อความ"**
   - กดปุ่ม **"ส่งเข้า Hermes-Agent ทันที"** เพื่อส่งข้อความทั้งหมดไปประมวลผลต่อ (หรือหากเปิดสวิตช์ส่งสด ข้อมูลจะถูกยิงเข้า Webhook ทุก Chunk โดยอัตโนมัติ)

---

## 🔌 รูปแบบ Payload ที่ส่งเข้า Hermes-Agent

### เมื่อส่งสรุปการประชุม (Meeting Summary):
```json
{
  "source": "google-meet",
  "event": "meeting_summary",
  "meetingTitle": "Google Meet - Team Weekly Sync",
  "durationSeconds": 1845,
  "timestamp": "2026-10-15T01:30:00.000Z",
  "transcript": "[09:00:15] สวัสดีครับทุกคน เริ่มการประชุมสัปดาห์นี้กันครับ\n[09:00:45] อัปเดตเรื่องระบบใหม่...",
  "items": [
    {
      "id": "1728952815000_1",
      "chunkIndex": 1,
      "timestamp": "09:00:15",
      "text": "สวัสดีครับทุกคน เริ่มการประชุมสัปดาห์นี้กันครับ"
    }
  ]
}
```

Headers ที่ส่ง:
- `Content-Type: application/json`
- `X-API-KEY: YOUR_HERMES_SECRET_TOKEN`
