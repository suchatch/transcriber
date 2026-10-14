// Popup Script for Meeting Audio Transcriber
// Handles UI states, tab capture initiation, microphone permission, and Hermes actions

let timerInterval = null;
let currentSettings = null;
let activeTab = null;

// DOM Elements
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const activeTabTitleEl = document.getElementById('active-tab-title');
const sessionTimerEl = document.getElementById('session-timer');
const toggleRecordBtn = document.getElementById('toggle-record-btn');
const recordBtnText = document.getElementById('record-btn-text');
const soundBarsContainer = document.querySelector('.audio-visualizer-container');
const soundBars = document.querySelectorAll('.sound-bars .bar');
const transcriptFeed = document.getElementById('transcript-feed');
const emptyState = document.getElementById('empty-state');
const chunkCounter = document.getElementById('chunk-counter');
const copyTranscriptBtn = document.getElementById('copy-transcript-btn');
const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
const sendHermesBtn = document.getElementById('send-hermes-btn');
const toastEl = document.getElementById('toast');
const toastMessageEl = document.getElementById('toast-message');

// Settings Form Elements
const tabLiveBtn = document.getElementById('tab-live-btn');
const tabSettingsBtn = document.getElementById('tab-settings-btn');
const panelLive = document.getElementById('panel-live');
const panelSettings = document.getElementById('panel-settings');
const settingsForm = document.getElementById('settings-form');
const sttProviderEl = document.getElementById('stt-provider');
const apiKeyEl = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key-visibility');
const modelNameEl = document.getElementById('model-name');
const groupModelEl = document.getElementById('group-model');
const customEndpointEl = document.getElementById('custom-endpoint');
const groupCustomEndpointEl = document.getElementById('group-custom-endpoint');
const languageEl = document.getElementById('language');
const chunkIntervalEl = document.getElementById('chunk-interval');
const includeMicEl = document.getElementById('include-mic');
const hermesUrlEl = document.getElementById('hermes-url');
const hermesKeyEl = document.getElementById('hermes-key');
const autoSendHermesEl = document.getElementById('auto-send-hermes');

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupSettingsUI();
  setupTranscriptActions();
  await detectActiveTab();
  await syncStateWithBackground();
});

// Detect current active tab
async function detectActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      activeTab = tab;
      activeTabTitleEl.textContent = tab.title || tab.url || 'แท็บปัจจุบัน';
    }
  } catch (err) {
    console.warn('Failed to get active tab:', err);
    activeTabTitleEl.textContent = 'ไม่สามารถดึงข้อมูลแท็บได้';
  }
}

// Sync state with background
async function syncStateWithBackground() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      console.warn('Could not contact background service worker:', chrome.runtime.lastError);
      return;
    }

    currentSettings = res.settings;
    populateSettingsForm(res.settings);

    // Render transcripts
    renderTranscripts(res.transcriptItems || []);

    // Update status & UI
    updateUIForStatus(res);

    if (res.isRecording && res.startTime) {
      startTimer(res.startTime);
    }
  });
}

// Setup Tab Navigation
function setupNavigation() {
  tabLiveBtn.addEventListener('click', () => {
    tabLiveBtn.classList.add('active');
    tabSettingsBtn.classList.remove('active');
    panelLive.classList.add('active');
    panelSettings.classList.remove('active');
  });

  tabSettingsBtn.addEventListener('click', () => {
    tabSettingsBtn.classList.add('active');
    tabLiveBtn.classList.remove('active');
    panelSettings.classList.add('active');
    panelLive.classList.remove('active');
  });
}

// Populate Settings in Form
function populateSettingsForm(s) {
  if (!s) return;
  sttProviderEl.value = s.sttProvider || 'groq';
  apiKeyEl.value = s.apiKey || '';
  modelNameEl.value = s.model || (s.sttProvider === 'openai' ? 'whisper-1' : 'whisper-large-v3');
  customEndpointEl.value = s.customEndpoint || '';
  languageEl.value = s.language || 'th';
  chunkIntervalEl.value = s.chunkInterval ? String(s.chunkInterval) : '30';
  includeMicEl.checked = s.includeMic !== false;
  hermesUrlEl.value = s.hermesUrl || '';
  hermesKeyEl.value = s.hermesApiKey || '';
  autoSendHermesEl.checked = !!s.autoSendHermes;

  toggleEndpointVisibility();
}

function toggleEndpointVisibility() {
  if (sttProviderEl.value === 'custom') {
    groupCustomEndpointEl.style.display = 'flex';
  } else {
    groupCustomEndpointEl.style.display = 'none';
  }
}

// Setup Settings Form Events
function setupSettingsUI() {
  sttProviderEl.addEventListener('change', () => {
    toggleEndpointVisibility();
    if (sttProviderEl.value === 'groq') {
      modelNameEl.value = 'whisper-large-v3';
    } else if (sttProviderEl.value === 'openai') {
      modelNameEl.value = 'whisper-1';
    }
  });

  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyEl.type === 'password') {
      apiKeyEl.type = 'text';
    } else {
      apiKeyEl.type = 'password';
    }
  });

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const newSettings = {
      sttProvider: sttProviderEl.value,
      apiKey: apiKeyEl.value.trim(),
      model: modelNameEl.value.trim(),
      customEndpoint: customEndpointEl.value.trim(),
      language: languageEl.value,
      chunkInterval: parseInt(chunkIntervalEl.value, 10) || 30,
      includeMic: includeMicEl.checked,
      hermesUrl: hermesUrlEl.value.trim(),
      hermesApiKey: hermesKeyEl.value.trim(),
      autoSendHermes: autoSendHermesEl.checked
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: newSettings }, (res) => {
      if (res && res.success) {
        currentSettings = newSettings;
        showToast('บันทึกการตั้งค่าเรียบร้อยแล้ว', 'success');
      } else {
        showToast('บันทึกการตั้งค่าไม่สำเร็จ', 'error');
      }
    });
  });
}

// Start / Stop Recording Handler
toggleRecordBtn.addEventListener('click', async () => {
  toggleRecordBtn.disabled = true;

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, async (res) => {
    if (res && res.isRecording) {
      // STOP recording
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING_REQUEST' }, (stopRes) => {
        toggleRecordBtn.disabled = false;
        if (stopRes && stopRes.success) {
          stopTimer();
          setButtonState(false);
          setStatusBadge('idle', 'พร้อมใช้งาน');
          showToast('หยุดบันทึกการประชุมแล้ว', 'normal');
        }
      });
    } else {
      // START recording
      await startRecordingFlow();
      toggleRecordBtn.disabled = false;
    }
  });
});

async function startRecordingFlow() {
  if (!activeTab || !activeTab.id) {
    showToast('กรุณาเปิดแท็บการประชุมก่อนเริ่มบันทึก', 'error');
    return;
  }

  // Ensure settings are loaded
  if (!currentSettings || (!currentSettings.apiKey && currentSettings.sttProvider !== 'custom')) {
    showToast('กรุณาระบุ API Key ในหน้าตั้งค่าก่อน', 'error');
    tabSettingsBtn.click();
    apiKeyEl.focus();
    return;
  }

  // If includeMic is enabled, request permission from popup context first
  if (currentSettings.includeMic) {
    try {
      const tempMic = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempMic.getTracks().forEach((t) => t.stop()); // Permission acquired!
    } catch (micErr) {
      console.warn('Microphone permission prompt failed or dismissed:', micErr);
      showToast('ไม่สามารถขอสิทธิ์ใช้ไมค์ได้: จะบันทึกเฉพาะเสียงแท็บ', 'normal');
    }
  }

  // Get Media Stream ID for active tab
  chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Unknown streamId error';
      console.error('getMediaStreamId failed:', err);
      showToast('ไม่สามารถดักจับเสียงแท็บได้: ' + err, 'error');
      return;
    }

    // Send start recording request to background service worker
    chrome.runtime.sendMessage(
      {
        type: 'START_RECORDING_REQUEST',
        streamId,
        tabId: activeTab.id,
        tabTitle: activeTab.title || 'Meeting'
      },
      (startRes) => {
        if (startRes && startRes.success) {
          setButtonState(true);
          setStatusBadge('recording', 'กำลังดักเสียงแท็บ + ไมค์');
          startTimer(Date.now());
          showToast('เริ่มดักจับเสียงการประชุมแล้ว', 'success');
        } else {
          const errMsg = startRes ? startRes.error : 'Failed to start';
          setStatusBadge('error', 'ข้อผิดพลาด');
          showToast('เกิดข้อผิดพลาด: ' + errMsg, 'error');
        }
      }
    );
  });
}

function setButtonState(isRecording) {
  if (isRecording) {
    toggleRecordBtn.classList.remove('btn-start');
    toggleRecordBtn.classList.add('btn-stop');
    recordBtnText.textContent = 'หยุดดักจับเสียง & แปลงข้อความ';
    soundBarsContainer.classList.add('active');
  } else {
    toggleRecordBtn.classList.remove('btn-stop');
    toggleRecordBtn.classList.add('btn-start');
    recordBtnText.textContent = 'เริ่มดักจับเสียง & แปลงข้อความ';
    soundBarsContainer.classList.remove('active');
    resetVisualizer();
  }
}

function setStatusBadge(type, text) {
  statusBadge.className = 'badge';
  statusBadge.classList.add('badge-' + type);
  statusText.textContent = text;
}

function updateUIForStatus(state) {
  setButtonState(state.isRecording);

  if (state.isRecording) {
    if (state.status === 'transcribing') {
      setStatusBadge('transcribing', 'กำลังแปลงข้อความ...');
    } else {
      setStatusBadge('recording', 'กำลังดักเสียงแท็บ + ไมค์');
    }
  } else if (state.status === 'error') {
    setStatusBadge('error', 'ข้อผิดพลาด');
  } else {
    setStatusBadge('idle', 'พร้อมใช้งาน');
  }

  if (state.activeTabTitle) {
    activeTabTitleEl.textContent = state.activeTabTitle;
  }
}

// Timer Functions
function startTimer(startTime) {
  stopTimer();
  updateTimerDisplay(startTime);
  timerInterval = setInterval(() => {
    updateTimerDisplay(startTime);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay(startTime) {
  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const hrs = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
  const secs = String(elapsedSec % 60).padStart(2, '0');
  sessionTimerEl.textContent = `${hrs}:${mins}:${secs}`;
}

// Visualizer animation from audio levels
function animateVisualizer(level) {
  if (soundBars.length === 0) return;
  const factor = Math.max(0.1, level / 100);

  soundBars.forEach((bar, idx) => {
    // Generate organic undulating heights based on level and index
    const wave = Math.sin(Date.now() / 150 + idx) * 0.4 + 0.6;
    const height = Math.max(3, Math.round(18 * factor * wave));
    bar.style.height = `${height}px`;
  });
}

function resetVisualizer() {
  soundBars.forEach((bar) => {
    bar.style.height = '4px';
  });
}

// Transcripts Rendering & Actions
function renderTranscripts(items) {
  chunkCounter.textContent = items.length;

  if (items.length === 0) {
    emptyState.style.display = 'flex';
    transcriptFeed.innerHTML = '';
    transcriptFeed.appendChild(emptyState);
    return;
  }

  emptyState.style.display = 'none';
  transcriptFeed.innerHTML = '';

  items.forEach((item) => {
    appendTranscriptDOM(item);
  });

  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
}

function appendTranscriptDOM(item) {
  if (emptyState.parentNode === transcriptFeed) {
    emptyState.remove();
  }

  const el = document.createElement('div');
  el.className = 'transcript-item';
  el.innerHTML = `
    <div class="transcript-item-meta">
      <span>#${item.chunkIndex || '-'}</span>
      <span>${item.timestamp || ''}</span>
    </div>
    <div class="transcript-item-text">${escapeHtml(item.text)}</div>
  `;

  transcriptFeed.appendChild(el);
  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
  chunkCounter.textContent = document.querySelectorAll('.transcript-item').length;
}

function setupTranscriptActions() {
  // Copy All Transcripts
  copyTranscriptBtn.addEventListener('click', () => {
    const items = document.querySelectorAll('.transcript-item');
    if (items.length === 0) {
      showToast('ไม่มีข้อความให้คัดลอก', 'normal');
      return;
    }

    let textToCopy = '';
    items.forEach((item) => {
      const meta = item.querySelector('.transcript-item-meta').innerText;
      const content = item.querySelector('.transcript-item-text').innerText;
      textToCopy += `[${meta}] ${content}\n`;
    });

    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast('คัดลอกข้อความทั้งหมดแล้ว!', 'success');
    });
  });

  // Clear Transcripts
  clearTranscriptBtn.addEventListener('click', () => {
    if (confirm('คุณต้องการล้างข้อความทั้งหมดใช่หรือไม่?')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_TRANSCRIPTS' }, () => {
        renderTranscripts([]);
        showToast('ล้างข้อความเรียบร้อย', 'normal');
      });
    }
  });

  // Send to Hermes Agent
  sendHermesBtn.addEventListener('click', () => {
    sendHermesBtn.disabled = true;
    sendHermesBtn.querySelector('span').textContent = 'กำลังส่งข้อมูล...';

    chrome.runtime.sendMessage({ type: 'SEND_TO_HERMES_REQUEST' }, (res) => {
      sendHermesBtn.disabled = false;
      sendHermesBtn.querySelector('span').textContent = 'ส่งเข้า Hermes-Agent ทันที';

      if (res && res.success) {
        showToast(`ส่งสำเร็จ! (${res.count} ข้อความ)`, 'success');
      } else {
        const err = res ? res.error : 'ส่งไม่สำเร็จ';
        showToast(`ส่งล้มเหลว: ${err}`, 'error');
      }
    });
  });
}

// Toast notification helper
function showToast(message, type = 'normal') {
  toastMessageEl.textContent = message;
  toastEl.className = 'toast show';
  if (type === 'success') toastEl.classList.add('toast-success');
  if (type === 'error') toastEl.classList.add('toast-error');

  setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3200);
}

// Utility: escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

// Listen for broadcast messages from background while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_CHANGED') {
    if (msg.status === 'transcribing') {
      setStatusBadge('transcribing', 'กำลังแปลงข้อความ...');
    } else if (msg.isRecording) {
      setStatusBadge('recording', 'กำลังดักเสียงแท็บ + ไมค์');
    } else {
      setStatusBadge('idle', 'พร้อมใช้งาน');
      stopTimer();
      setButtonState(false);
    }
  } else if (msg.type === 'NEW_TRANSCRIPT_ITEM') {
    appendTranscriptDOM(msg.item);
  } else if (msg.type === 'AUDIO_LEVEL_UPDATE') {
    animateVisualizer(msg.level);
  } else if (msg.type === 'TRANSCRIPTS_CLEARED') {
    renderTranscripts([]);
  } else if (msg.type === 'TRANSCRIPTION_ERROR') {
    showToast(`STT ข้อผิดพลาด (${msg.chunkIndex}): ${msg.error}`, 'error');
  }
});
