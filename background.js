// Background Service Worker for Meeting Audio Transcriber
// Coordinates offscreen document, manages state, calls Whisper API, and sends data to Hermes-Agent

const DEFAULT_SETTINGS = {
  sttProvider: 'groq', // 'groq', 'openai', 'custom'
  apiKey: '',   // ผู้ใช้กรอกเองในหน้า Settings (เก็บใน chrome.storage.local)
  customEndpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
  model: 'whisper-large-v3',
  language: 'th',
  hermesUrl: 'https://your-hermes-domain.com/api/webhook/meeting',
  hermesApiKey: '',
  autoSendHermes: false, // Stream each chunk immediately to Hermes
  includeMic: true,
  chunkInterval: 30 // seconds
};

// Runtime session state
let state = {
  isRecording: false,
  activeTabId: null,
  activeTabTitle: '',
  startTime: null,
  transcriptItems: [],
  status: 'idle', // 'idle' | 'recording' | 'transcribing' | 'error'
  lastError: null,
  audioLevel: 0
};

// Load saved settings or set defaults
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result.settings || {}) });
    });
  });
}

// ---------------------------------------------------------------------------
// Transcript persistence (MV3 fix)
// The service worker is killed after ~30s idle, wiping in-memory `state`.
// Persist transcripts to chrome.storage so they survive worker restarts.
// ---------------------------------------------------------------------------
const STORAGE_KEY_TRANSCRIPTS = 'transcriptItems';
const STORAGE_KEY_SESSION = 'sessionMeta';

async function loadTranscripts() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_TRANSCRIPTS], (result) => {
      resolve(Array.isArray(result[STORAGE_KEY_TRANSCRIPTS]) ? result[STORAGE_KEY_TRANSCRIPTS] : []);
    });
  });
}

async function saveTranscripts(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_TRANSCRIPTS]: items }, resolve);
  });
}

async function appendTranscript(item) {
  const items = await loadTranscripts();
  items.push(item);
  await saveTranscripts(items);
  return items;
}

async function clearTranscripts() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_TRANSCRIPTS]: [] }, resolve);
  });
}

// Session meta (title + start time) also needs to survive worker restarts
async function saveSessionMeta(meta) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_SESSION]: meta }, resolve);
  });
}

async function loadSessionMeta() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_SESSION], (result) => {
      resolve(result[STORAGE_KEY_SESSION] || null);
    });
  });
}

// Rehydrate in-memory state from persistent storage (call on every wake)
async function rehydrateState() {
  const [items, meta] = await Promise.all([loadTranscripts(), loadSessionMeta()]);
  state.transcriptItems = items;
  if (meta) {
    state.activeTabTitle = meta.activeTabTitle || state.activeTabTitle;
    state.startTime = meta.startTime || state.startTime;
    state.activeTabId = meta.activeTabId != null ? meta.activeTabId : state.activeTabId;
  }
  return items;
}

// Ensure offscreen document exists
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capturing and mixing meeting tab audio and microphone for transcription'
    });
    console.log('[Background] Offscreen document created successfully');
  } catch (err) {
    if (!err.message.includes('Only a single offscreen document may be created')) {
      throw err;
    }
  }
}

// Close offscreen document when finished
async function closeOffscreenDocument() {
  try {
    if ('getContexts' in chrome.runtime) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')]
      });
      if (contexts.length === 0) return;
    }
    await chrome.offscreen.closeDocument();
    console.log('[Background] Offscreen document closed');
  } catch (err) {
    console.warn('[Background] Error closing offscreen document:', err);
  }
}

// Broadcast message to any active UI views (popup)
function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Expected when popup is not currently open
  });
}

// Listen to messages from popup and offscreen
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;

  switch (msg.type) {
    case 'GET_STATE': {
      // Rehydrate from chrome.storage so counts survive worker suspension
      rehydrateState()
        .then((items) => getSettings().then((settings) => ({ items, settings })))
        .then(({ items, settings }) => {
          sendResponse({
            ...state,
            transcriptItems: items,
            settings
          });
        })
        .catch((err) => {
          console.error('[Background] GET_STATE rehydrate failed:', err);
          sendResponse({ ...state, settings: DEFAULT_SETTINGS });
        });
      return true;
    }

    case 'START_RECORDING_REQUEST': {
      handleStartRecording(msg)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'STOP_RECORDING_REQUEST': {
      handleStopRecording()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'AUDIO_CHUNK': {
      handleAudioChunk(msg);
      sendResponse({ received: true });
      break;
    }

    case 'AUDIO_LEVEL': {
      state.audioLevel = msg.level;
      broadcastToPopup({ type: 'AUDIO_LEVEL_UPDATE', level: msg.level });
      break;
    }

    case 'TAB_CAPTURE_ENDED': {
      console.log('[Background] Tab capture ended unexpectedly');
      handleStopRecording();
      break;
    }

    case 'SEND_TO_HERMES_REQUEST': {
      handleManualSendToHermes()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'CLEAR_TRANSCRIPTS': {
      state.transcriptItems = [];
      clearTranscripts().then(() => {
        broadcastToPopup({ type: 'TRANSCRIPTS_CLEARED' });
        sendResponse({ success: true });
      });
      return true;
    }

    case 'SAVE_SETTINGS': {
      chrome.storage.local.set({ settings: msg.settings }, () => {
        broadcastToPopup({ type: 'SETTINGS_SAVED', settings: msg.settings });
        sendResponse({ success: true });
      });
      return true;
    }
  }
});

// Start recording flow
async function handleStartRecording({ tabId, tabTitle, streamId }) {
  const settings = await getSettings();

  if (!settings.apiKey && settings.sttProvider !== 'custom') {
    state.status = 'error';
    state.lastError = 'กรุณาระบุ API Key ของ ' + (settings.sttProvider === 'groq' ? 'Groq' : 'OpenAI') + ' ในการตั้งค่า';
    return { success: false, error: state.lastError };
  }

  try {
    state.isRecording = true;
    state.activeTabId = tabId;
    state.activeTabTitle = tabTitle || 'Meeting Tab';
    state.startTime = Date.now();
    state.status = 'recording';
    state.lastError = null;

    // Persist session meta + start a clean transcript slate for this meeting
    await clearTranscripts();
    await saveSessionMeta({
      activeTabId: tabId,
      activeTabTitle: state.activeTabTitle,
      startTime: state.startTime
    });

    // Ensure offscreen document is ready
    await ensureOffscreenDocument();

    // Send start command to offscreen
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_RECORDING',
      streamId: streamId,
      includeMic: settings.includeMic,
      intervalSeconds: settings.chunkInterval
    });

    if (!response || !response.success) {
      throw new Error(response ? response.error : 'Failed to start offscreen recording');
    }

    broadcastToPopup({
      type: 'STATUS_CHANGED',
      status: state.status,
      isRecording: true,
      activeTabTitle: state.activeTabTitle,
      startTime: state.startTime
    });

    return { success: true };
  } catch (err) {
    console.error('[Background] handleStartRecording failed:', err);
    state.isRecording = false;
    state.status = 'error';
    state.lastError = err.message;
    await closeOffscreenDocument();
    return { success: false, error: err.message };
  }
}

// Stop recording flow
async function handleStopRecording() {
  if (!state.isRecording) return { success: true };

  state.isRecording = false;
  state.status = 'idle';
  state.audioLevel = 0;

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'STOP_RECORDING'
    });
  } catch (e) {
    console.warn('[Background] Offscreen stop message error:', e);
  }

  await closeOffscreenDocument();

  broadcastToPopup({
    type: 'STATUS_CHANGED',
    status: state.status,
    isRecording: false
  });

  return { success: true };
}

// Process incoming Audio Chunk with Whisper STT
async function handleAudioChunk({ dataUrl, chunkIndex, size }) {
  const settings = await getSettings();
  console.log(`[Background] Processing chunk #${chunkIndex} (${Math.round(size / 1024)} KB)`);

  state.status = 'transcribing';
  broadcastToPopup({ type: 'STATUS_CHANGED', status: 'transcribing' });

  try {
    // Convert Data URL to Blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // Transcribe with Whisper API
    const text = await transcribeAudioBlob(blob, settings);

    if (text && text.trim().length > 0) {
      const trimmedText = text.trim();
      const newItem = {
        id: Date.now() + '_' + chunkIndex,
        chunkIndex,
        timestamp: new Date().toLocaleTimeString('th-TH', { hour12: false }),
        text: trimmedText
      };

      // Persist to chrome.storage (survives MV3 worker suspension)
      await appendTranscript(newItem);
      state.transcriptItems.push(newItem);
      console.log(`[Background] Transcribed chunk #${chunkIndex}:`, trimmedText);

      broadcastToPopup({
        type: 'NEW_TRANSCRIPT_ITEM',
        item: newItem
      });

      // Stream to Hermes immediately if configured
      if (settings.autoSendHermes && settings.hermesUrl) {
        sendChunkToHermes(newItem, settings).catch((err) => {
          console.error('[Background] Failed to send live chunk to Hermes:', err);
        });
      }
    }
  } catch (err) {
    console.error(`[Background] Transcription failed for chunk #${chunkIndex}:`, err);
    state.lastError = `STT Error: ${err.message}`;
    broadcastToPopup({
      type: 'TRANSCRIPTION_ERROR',
      error: err.message,
      chunkIndex
    });
  } finally {
    state.status = state.isRecording ? 'recording' : 'idle';
    broadcastToPopup({ type: 'STATUS_CHANGED', status: state.status });
  }
}

// Transcribe audio blob via Whisper API (Groq or OpenAI)
async function transcribeAudioBlob(audioBlob, settings) {
  let endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
  let defaultModel = 'whisper-large-v3';

  if (settings.sttProvider === 'openai') {
    endpoint = 'https://api.openai.com/v1/audio/transcriptions';
    defaultModel = 'whisper-1';
  } else if (settings.sttProvider === 'custom') {
    endpoint = settings.customEndpoint || endpoint;
    defaultModel = settings.model || 'whisper-large-v3';
  }

  const model = settings.model || defaultModel;
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
  formData.append('model', model);

  if (settings.language && settings.language !== 'auto') {
    formData.append('language', settings.language);
  }

  const headers = {};
  if (settings.apiKey) {
    headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: formData
  });

  if (!res.ok) {
    let errBody = '';
    try {
      const errJson = await res.json();
      errBody = errJson.error ? errJson.error.message : JSON.stringify(errJson);
    } catch {
      errBody = await res.text();
    }
    throw new Error(`Whisper API HTTP ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  return data.text || '';
}

// Send live chunk to Hermes Agent webhook
async function sendChunkToHermes(item, settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.hermesApiKey) {
    headers['X-API-KEY'] = settings.hermesApiKey.trim();
  }

  const payload = {
    source: 'google-meet',
    event: 'live_chunk',
    meetingTitle: state.activeTabTitle,
    chunkIndex: item.chunkIndex,
    timestamp: new Date().toISOString(),
    transcript: item.text
  };

  const res = await fetch(settings.hermesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Hermes Webhook returned status ${res.status}`);
  }
}

// Send accumulated full meeting transcript to Hermes Agent
async function handleManualSendToHermes() {
  const settings = await getSettings();

  if (!settings.hermesUrl) {
    throw new Error('กรุณาระบุ Hermes Webhook URL ในการตั้งค่า');
  }

  // Read from chrome.storage — in-memory state is wiped when the MV3 worker
  // is suspended, which made this throw "ยังไม่มีข้อความ" despite transcripts
  // being visible in the popup.
  const items = await rehydrateState();

  if (!items || items.length === 0) {
    throw new Error('ยังไม่มีข้อความการประชุมที่จะส่ง');
  }

  const fullTranscript = items
    .map((item) => `[${item.timestamp}] ${item.text}`)
    .join('\n');

  const headers = { 'Content-Type': 'application/json' };
  if (settings.hermesApiKey) {
    headers['X-API-KEY'] = settings.hermesApiKey.trim();
  }

  const payload = {
    source: 'google-meet',
    event: 'meeting_summary',
    meetingTitle: state.activeTabTitle || 'Meeting',
    durationSeconds: state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0,
    timestamp: new Date().toISOString(),
    transcript: fullTranscript,
    items: items
  };

  console.log('[Background] Sending full meeting transcript to Hermes:', settings.hermesUrl);

  const res = await fetch(settings.hermesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Hermes Webhook Error (${res.status}): ${errText}`);
  }

  return { success: true, count: items.length };
}
