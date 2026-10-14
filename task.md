การสร้างระบบดักเสียงจากเครื่องเพื่อส่งเข้า Whisper API และส่งต่อให้ hermes-agent มี 2 ทางเลือกหลัก: Chrome Extension (เน้นเว็บ Google Meet/Teams บนเบราว์เซอร์) หรือ Desktop App (Tauri / Rust) (ดักได้ทุกโปรแกรมรวมถึง Desktop App ของ Teams/Zoom)ด้านล่างนี้คือแนวทางที่คลีนและเร็วที่สุดด้วย Chrome Extension (Manifest V3) ซึ่งแทบไม่ต้องลง Driver เสียงเสมือนในเครื่อง1.วางโครงสร้างไฟล์ Chrome Extension:Prerequisite.สร้างโฟลเดอร์โปรเจกต์ใหม่และเตรียมไฟล์ Manifest V3 เพื่อขอสิทธิ์ดักจับเสียงจากแท็บ (tabCapture) และไมโครโฟน (audioCapture)สร้างไฟล์ manifest.json:JSON{
  "manifest_version": 3,
  "name": "Meeting Audio Transcriber",
  "version": "1.0",
  "permissions": ["tabCapture", "activeTab", "offscreen"],
  "action": {
    "default_popup": "popup.html"
  },
  "background": {
    "service_worker": "background.js"
  }
}
วิธีตรวจสอบความสำเร็จ: เข้า chrome://extensions ใน Google Chrome เปิด Developer mode แล้วกด Load unpacked ชี้มาที่โฟลเดอร์นี้ ส่วนขยายต้องโหลดขึ้นมาโดยไม่มีขีดแดงเตือน Error2.สร้าง Offscreen Document เพื่อบันทึกเสียงสด:Manifest V3 Requirement.Service Worker ของ Manifest V3 ไม่สามารถจับ Stream ของ MediaRecorder ได้ต่อเนื่อง จึงต้องรันการบันทึกผ่านเอกสารเบื้องหลัง (Offscreen Document)สร้างไฟล์ offscreen.html:HTML<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body><script src="offscreen.js"></script></body>
</html>
สร้างไฟล์ offscreen.js เพื่อรวมเสียงจากแท็บประชุมเข้ากับ MediaRecorder:JavaScriptchrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "START_RECORDING") {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: msg.streamId
        }
      }
    });

    // ต่อสายเสียงให้ออกลำโพงตามปกติ (ไม่งั้นในหูฟังคุณจะไม่ได้ยินเสียงเพื่อน)
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);

    // อัดเสียงเป็น Chunking ทุก 30 วินาที
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        chrome.runtime.sendMessage({
          type: "AUDIO_CHUNK",
          blobData: await e.data.arrayBuffer()
        });
      }
    };
    recorder.start(30000); // 30 seconds interval
  }
});
วิธีตรวจสอบความสำเร็จ: เมื่อเริ่มอัด ให้ลองพูดคุยในแท็บ Google Meet แล้วสังเกตว่าเสียงคู่สนทนายังคงดังออกลำโพง/หูฟังตามปกติ ไม่เงียบดับไป3.ส่งเสียงไปแปลงข้อความด้วย Whisper API:STT Processing.สร้างฟังก์ชันใน background.js เพื่อรับไฟล์เสียงชิ้นย่อย แปลงเป็น FormData แล้วยิงไปที่ Speech-to-Text API (เช่น Groq Whisper Large-v3 หรือ OpenAI Whisper):JavaScriptasync function transcribeAudio(arrayBuffer) {
  const blob = new Blob([arrayBuffer], { type: "audio/webm" });
  const formData = new FormData();
  formData.append("file", blob, "audio.webm");
  formData.append("model", "whisper-large-v3");
  formData.append("language", "th"); // ระบุภาษาไทย

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer YOUR_GROQ_OR_OPENAI_API_KEY"
    },
    body: formData
  });

  const data = await res.json();
  return data.text; // ข้อความที่แปลงได้
}
วิธีตรวจสอบความสำเร็จ: เปิดแถบ Console ของ Background Service Worker ตรวจสอบ data.text ว่ามีข้อความภาษาไทยที่คุยในห้องประชุม Log ออกมาถูกต้อง4.ส่ง Transcription เข้า Webhook ของ Hermes-Agent:Integration.เมื่อรวบรวมข้อความจนจบการประชุม (หรือส่งเป็นประโยคสด) ให้ยิง HTTP POST Request ตรงไปหา Endpoint / Webhook ของ hermes-agent บน Cloud Server ของคุณ:JavaScriptasync function sendToHermes(meetingTranscript) {
  await fetch("https://your-hermes-domain.com/api/webhook/meeting", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": "YOUR_HERMES_SECRET_TOKEN"
    },
    body: JSON.stringify({
      source: "google-meet",
      timestamp: new Date().toISOString(),
      transcript: meetingTranscript
    })
  });
}
วิธีตรวจสอบความสำเร็จ: เช็กฝั่ง hermes-agent (ผ่าน Docker Log หรือ Nginx Access Log) ว่ามี Payload ก้อนข้อความยิงเข้ามา และ Agent เริ่มต้น Flow สรุปงานส่งเข้า LINE หรือ Google Sheets ทันทีข้อควรทราบเรื่องเสียงไมค์ของตัวคุณเอง (Your Own Mic)chrome.tabCapture จะดักจับได้เฉพาะ เสียงของคนอื่นที่พูดออกมาจากแท็บหากต้องการให้ข้อความมี เสียงที่คุณพูดเอง เข้าไปด้วย:ขอสิทธิ์ไมค์ใน Extension เพิ่มด้วย navigator.mediaDevices.getUserMedia({ audio: true })ใช้ AudioContext มิกซ์ (Mix) เสียงจาก Tab Stream และ Mic Stream เข้าเป็นก้อนเดียว ก่อนส่งเข้า MediaRecorder