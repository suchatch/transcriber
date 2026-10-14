// Offscreen document script for Meeting Audio Transcriber
// Captures tab audio, optionally mixes microphone audio, and records chunks for Whisper API

let audioContext = null;
let tabStream = null;
let micStream = null;
let mixedDestination = null;
let currentRecorder = null;
let chunkTimer = null;
let levelInterval = null;
let isRecording = false;
let chunkCount = 0;
let chunkIntervalMs = 30000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'START_RECORDING':
      startRecording(msg)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.error('[Offscreen] startRecording failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // Keep message channel open for async response

    case 'STOP_RECORDING':
      stopRecording()
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.error('[Offscreen] stopRecording failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
  }
});

async function startRecording({ streamId, includeMic = true, intervalSeconds = 30 }) {
  if (isRecording) {
    console.warn('[Offscreen] Recording is already in progress');
    return;
  }

  chunkIntervalMs = Math.max(10, intervalSeconds) * 1000;
  chunkCount = 0;
  isRecording = true;

  try {
    // 1. Capture audio stream from the target Chrome tab
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // Detect if user closes tab or stops capturing
    const tabAudioTrack = tabStream.getAudioTracks()[0];
    if (tabAudioTrack) {
      tabAudioTrack.onended = () => {
        console.log('[Offscreen] Tab audio track ended');
        chrome.runtime.sendMessage({
          type: 'TAB_CAPTURE_ENDED',
          reason: 'Tab track closed'
        });
      };
    }

    // 2. Setup AudioContext to mix audio streams and playback through speakers
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const tabSource = audioContext.createMediaStreamSource(tabStream);

    // CRITICAL: Connect tab audio to speakers/headphones so user can hear the meeting
    tabSource.connect(audioContext.destination);

    // Create a destination stream that mixes all audio to be recorded
    mixedDestination = audioContext.createMediaStreamDestination();
    tabSource.connect(mixedDestination);

    // 3. Capture microphone if enabled
    if (includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

        const micSource = audioContext.createMediaStreamSource(micStream);
        // CRITICAL: Only connect mic to the recording destination, NEVER to audioContext.destination
        // This prevents the user from hearing their own voice echo back with delay!
        micSource.connect(mixedDestination);
        console.log('[Offscreen] Microphone attached and mixed successfully');
      } catch (micErr) {
        console.warn('[Offscreen] Failed to capture microphone:', micErr);
        chrome.runtime.sendMessage({
          type: 'MIC_STATUS',
          active: false,
          error: micErr.message
        });
      }
    }

    // 4. Setup Audio Level Analyser to monitor audio activity
    setupAudioLevelMonitor(tabSource);

    // 5. Begin recording standalone audio chunks
    recordNextChunk();
    console.log('[Offscreen] Started recording cycle with interval:', chunkIntervalMs, 'ms');
  } catch (err) {
    isRecording = false;
    cleanupStreams();
    throw err;
  }
}

function setupAudioLevelMonitor(audioSource) {
  if (!audioContext || !audioSource) return;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  audioSource.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  levelInterval = setInterval(() => {
    if (!isRecording) {
      clearInterval(levelInterval);
      return;
    }

    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const average = sum / dataArray.length;
    const normalizedLevel = Math.min(100, Math.round((average / 128) * 100));

    // Send audio level to background/popup for visualizer
    chrome.runtime.sendMessage({
      type: 'AUDIO_LEVEL',
      level: normalizedLevel
    }).catch(() => {}); // Ignore errors if popup is closed
  }, 250);
}

function recordNextChunk() {
  if (!isRecording || !mixedDestination) return;

  let mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'audio/webm';
  }

  let recorder;
  try {
    recorder = new MediaRecorder(mixedDestination.stream, { mimeType });
  } catch (err) {
    console.error('[Offscreen] Error instantiating MediaRecorder:', err);
    return;
  }

  currentRecorder = recorder;
  const chunkParts = [];

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunkParts.push(event.data);
    }
  };

  recorder.onstop = async () => {
    if (chunkParts.length > 0) {
      const blob = new Blob(chunkParts, { type: mimeType });
      // Filter out tiny or empty chunks (< 2KB is usually silence or empty headers)
      if (blob.size > 2048) {
        const reader = new FileReader();
        reader.onloadend = () => {
          chrome.runtime.sendMessage({
            type: 'AUDIO_CHUNK',
            dataUrl: reader.result,
            size: blob.size,
            chunkIndex: ++chunkCount,
            timestamp: new Date().toISOString()
          }).catch((err) => {
            console.error('[Offscreen] Failed to send AUDIO_CHUNK to background:', err);
          });
        };
        reader.readAsDataURL(blob);
      }
    }

    // Schedule next chunk if still in recording state
    if (isRecording) {
      recordNextChunk();
    }
  };

  recorder.start();

  // Stop the current recorder when interval elapses to seal the WebM container with full header
  chunkTimer = setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
    }
  }, chunkIntervalMs);
}

async function stopRecording() {
  isRecording = false;

  if (chunkTimer) {
    clearTimeout(chunkTimer);
    chunkTimer = null;
  }

  if (levelInterval) {
    clearInterval(levelInterval);
    levelInterval = null;
  }

  if (currentRecorder && currentRecorder.state === 'recording') {
    try {
      currentRecorder.stop();
    } catch (e) {
      console.warn('[Offscreen] Error stopping currentRecorder:', e);
    }
  }

  cleanupStreams();
  console.log('[Offscreen] Recording stopped cleanly');
}

function cleanupStreams() {
  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
    tabStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  mixedDestination = null;
  currentRecorder = null;
}
