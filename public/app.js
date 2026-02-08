(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    // Voice Activity Detection
    SPEECH_THRESHOLD: 0.018,
    SILENCE_THRESHOLD: 0.009,
    SILENCE_DURATION: 900,
    MIN_RECORDING_DURATION: 350,

    // Audio
    FFT_SIZE: 2048,

    // Visual
    ORB_BASE_RADIUS: 75,
    PARTICLE_COUNT: 45,

    // Conversation
    MAX_HISTORY: 20,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE MACHINE
  // ═══════════════════════════════════════════════════════════════════════════

  const State = {
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
  };

  const StateMachine = {
    current: State.IDLE,
    listeners: [],

    transition(newState) {
      if (this.current === newState) return;
      const old = this.current;
      this.current = newState;
      this.listeners.forEach((fn) => fn(newState, old));
      this.updateUI(newState);
    },

    onChange(fn) {
      this.listeners.push(fn);
    },

    updateUI(state) {
      const label = document.getElementById('state-label');
      const stateText = {
        [State.IDLE]: 'STANDBY',
        [State.LISTENING]: 'LISTENING',
        [State.PROCESSING]: 'PROCESSING',
        [State.SPEAKING]: 'RESPONDING',
      };
      label.textContent = stateText[state] || state.toUpperCase();
      label.className = 'state-label ' + state;

      // Status indicators
      const mic = document.getElementById('mic-status');
      const ai = document.getElementById('ai-status');

      mic.classList.toggle('active', state === State.LISTENING);
      ai.classList.toggle('warning', state === State.PROCESSING);
      ai.classList.toggle('active', state === State.SPEAKING);
      if (state !== State.PROCESSING) ai.classList.remove('warning');
      if (state !== State.SPEAKING) ai.classList.remove('active');

      // Button state
      const btn = document.getElementById('listen-btn');
      btn.classList.toggle('active', state === State.LISTENING);
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIO CAPTURE
  // ═══════════════════════════════════════════════════════════════════════════

  const AudioCapture = {
    stream: null,
    audioContext: null,
    sourceNode: null,
    analyser: null,
    recorder: null,
    chunks: [],
    mimeType: '',
    recordingStartTime: 0,

    async init() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      this.audioContext = new AudioContext();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = CONFIG.FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.3;
      this.sourceNode.connect(this.analyser);

      // Determine best supported mime type
      const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      this.mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';

      return this.analyser;
    },

    startRecording() {
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType || undefined,
        audioBitsPerSecond: 32000,
      });
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.recordingStartTime = Date.now();
      this.recorder.start();
    },

    stopRecording() {
      return new Promise((resolve) => {
        if (!this.recorder || this.recorder.state !== 'recording') {
          resolve(null);
          return;
        }

        const duration = Date.now() - this.recordingStartTime;
        if (duration < CONFIG.MIN_RECORDING_DURATION) {
          this.recorder.stop();
          resolve(null);
          return;
        }

        this.recorder.onstop = () => {
          const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
          resolve(blob);
        };
        this.recorder.stop();
      });
    },

    getRMSLevel() {
      const data = new Float32Array(this.analyser.frequencyBinCount);
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
      }
      return Math.sqrt(sum / data.length);
    },

    getFrequencyData() {
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      return data;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // VOICE ACTIVITY DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  const VAD = {
    enabled: false,
    speechDetected: false,
    silenceStart: 0,
    onSpeechStart: null,
    onSpeechEnd: null,

    start(callbacks) {
      this.onSpeechStart = callbacks.onSpeechStart;
      this.onSpeechEnd = callbacks.onSpeechEnd;
      this.enabled = true;
      this.speechDetected = false;
      this.silenceStart = 0;
      this.monitor();
    },

    stop() {
      this.enabled = false;
      this.speechDetected = false;
    },

    monitor() {
      if (!this.enabled) return;

      const rms = AudioCapture.getRMSLevel();

      // Update audio level bar
      const levelPct = Math.min(100, rms * 3500);
      document.getElementById('audio-level-bar').style.setProperty('--level', levelPct + '%');

      // Feed energy to visualizer
      OrbVisualizer.setEnergy(rms * 12);

      if (rms > CONFIG.SPEECH_THRESHOLD) {
        if (!this.speechDetected) {
          this.speechDetected = true;
          if (this.onSpeechStart) this.onSpeechStart();
        }
        this.silenceStart = 0;
      } else if (rms < CONFIG.SILENCE_THRESHOLD && this.speechDetected) {
        if (this.silenceStart === 0) {
          this.silenceStart = Date.now();
        } else if (Date.now() - this.silenceStart > CONFIG.SILENCE_DURATION) {
          this.speechDetected = false;
          this.silenceStart = 0;
          if (this.onSpeechEnd) this.onSpeechEnd();
        }
      }

      requestAnimationFrame(() => this.monitor());
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // WAV ENCODER (Venice ASR requires WAV/MP3/FLAC - not webm)
  // ═══════════════════════════════════════════════════════════════════════════

  const WavEncoder = {
    /**
     * Convert any audio blob (webm, ogg, etc.) to WAV format
     * by decoding through AudioContext and re-encoding as linear PCM.
     */
    async blobToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new OfflineAudioContext(1, 1, 16000);

      let audioBuffer;
      try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      } catch (e) {
        console.error('Failed to decode audio blob:', e);
        throw new Error('Audio decode failed');
      }

      // Resample to 16kHz mono for optimal ASR
      const targetSampleRate = 16000;
      const offlineCtx = new OfflineAudioContext(
        1,
        Math.ceil(audioBuffer.duration * targetSampleRate),
        targetSampleRate
      );
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineCtx.destination);
      source.start(0);
      const resampled = await offlineCtx.startRendering();

      return this.encodeWAV(resampled);
    },

    encodeWAV(audioBuffer) {
      const numChannels = 1;
      const sampleRate = audioBuffer.sampleRate;
      const samples = audioBuffer.getChannelData(0);
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const dataSize = samples.length * (bitsPerSample / 8);
      const headerSize = 44;

      const buffer = new ArrayBuffer(headerSize + dataSize);
      const view = new DataView(buffer);

      // RIFF header
      this.writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      this.writeString(view, 8, 'WAVE');

      // fmt chunk
      this.writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);           // chunk size
      view.setUint16(20, 1, true);            // PCM format
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitsPerSample, true);

      // data chunk
      this.writeString(view, 36, 'data');
      view.setUint32(40, dataSize, true);

      // Write PCM samples (float32 -> int16)
      let offset = 44;
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }

      return new Blob([buffer], { type: 'audio/wav' });
    },

    writeString(view, offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // API CLIENT
  // ═══════════════════════════════════════════════════════════════════════════

  const API = {
    conversationHistory: [],

    async transcribe(audioBlob) {
      // Convert to WAV (Venice ASR doesn't accept webm/opus)
      const wavBlob = await WavEncoder.blobToWav(audioBlob);

      const formData = new FormData();
      formData.append('audio', wavBlob, 'recording.wav');

      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Transcription failed: ${res.status}`);
      }
      return res.json();
    },

    async chatStream(userText, onSentence) {
      this.conversationHistory.push({ role: 'user', content: userText });

      if (this.conversationHistory.length > CONFIG.MAX_HISTORY) {
        this.conversationHistory = this.conversationHistory.slice(-CONFIG.MAX_HISTORY);
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.conversationHistory }),
      });

      if (!res.ok) {
        throw new Error(`Chat failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.error) throw new Error(data.error);
            if (data.text) {
              fullResponse += data.text;
              onSentence(data);
            }
            if (data.done && !data.text) {
              // Stream complete with no remaining text
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }

      this.conversationHistory.push({ role: 'assistant', content: fullResponse });
      return fullResponse;
    },

    async tts(text, index) {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, index }),
      });

      if (!res.ok) {
        throw new Error(`TTS failed: ${res.status}`);
      }
      return res.arrayBuffer();
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIO QUEUE MANAGER (Gapless Playback)
  // ═══════════════════════════════════════════════════════════════════════════

  class AudioQueueManager {
    constructor(audioContext) {
      this.audioContext = audioContext;
      this.queue = new Map();
      this.nextPlayIndex = 0;
      this.isPlaying = false;
      this.scheduledEndTime = 0;
      this.completionResolve = null;
      this.allEnqueued = false;
      this.totalExpected = -1;
    }

    enqueue(index, audioBuffer) {
      this.queue.set(index, audioBuffer);
      this.tryPlayNext();
    }

    markAllEnqueued(total) {
      this.allEnqueued = true;
      this.totalExpected = total;
      this.checkCompletion();
    }

    tryPlayNext() {
      if (!this.queue.has(this.nextPlayIndex)) return;

      const buffer = this.queue.get(this.nextPlayIndex);
      this.queue.delete(this.nextPlayIndex);

      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);

      const startTime = Math.max(this.audioContext.currentTime + 0.02, this.scheduledEndTime);
      source.start(startTime);
      this.scheduledEndTime = startTime + buffer.duration;

      this.nextPlayIndex++;
      this.isPlaying = true;

      source.onended = () => {
        if (!this.queue.has(this.nextPlayIndex)) {
          this.isPlaying = false;
          this.checkCompletion();
        }
        this.tryPlayNext();
      };

      // Pre-schedule next if already available
      this.tryPlayNext();
    }

    checkCompletion() {
      if (this.allEnqueued && this.nextPlayIndex >= this.totalExpected && !this.isPlaying) {
        if (this.completionResolve) {
          this.completionResolve();
          this.completionResolve = null;
        }
      }
    }

    waitForCompletion() {
      return new Promise((resolve) => {
        this.completionResolve = resolve;
        this.checkCompletion();
      });
    }

    clear() {
      this.queue.clear();
      this.nextPlayIndex = 0;
      this.isPlaying = false;
      this.scheduledEndTime = 0;
      this.allEnqueued = false;
      this.totalExpected = -1;
      if (this.completionResolve) {
        this.completionResolve();
        this.completionResolve = null;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORB VISUALIZER (Canvas)
  // ═══════════════════════════════════════════════════════════════════════════

  const OrbVisualizer = {
    canvas: null,
    ctx: null,
    state: 'idle',
    energy: 0,
    targetEnergy: 0,
    phase: 0,
    particles: [],
    centerX: 0,
    centerY: 0,
    dpr: 1,
    width: 0,
    height: 0,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      this.initParticles(CONFIG.PARTICLE_COUNT);
      this.animate();
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      this.dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.width = rect.width;
      this.height = rect.height;
      this.canvas.width = rect.width * this.dpr;
      this.canvas.height = rect.height * this.dpr;
      this.ctx.scale(this.dpr, this.dpr);
      this.centerX = rect.width / 2;
      this.centerY = rect.height / 2;
    },

    initParticles(count) {
      this.particles = Array.from({ length: count }, () => ({
        angle: Math.random() * Math.PI * 2,
        radius: CONFIG.ORB_BASE_RADIUS + 25 + Math.random() * 65,
        speed: 0.001 + Math.random() * 0.004,
        size: 0.5 + Math.random() * 2,
        opacity: 0.15 + Math.random() * 0.45,
        drift: Math.random() * 0.5 - 0.25,
      }));
    },

    setState(state) {
      this.state = state;
    },

    setEnergy(value) {
      this.targetEnergy = Math.min(1, Math.max(0, value));
    },

    animate() {
      const { ctx, width, height, centerX, centerY } = this;
      ctx.clearRect(0, 0, width, height);

      // Smooth energy interpolation
      this.energy += (this.targetEnergy - this.energy) * 0.12;
      this.phase += 0.015;

      // Gradually decay target energy for idle breathing
      if (this.state === 'idle') {
        this.targetEnergy *= 0.95;
      }

      // Colors based on state
      let primary, glow, glowRGB;
      switch (this.state) {
        case 'listening':
          primary = '#00f0ff';
          glow = 'rgba(0, 240, 255, ';
          glowRGB = [0, 240, 255];
          break;
        case 'processing':
          primary = '#ff9500';
          glow = 'rgba(255, 149, 0, ';
          glowRGB = [255, 149, 0];
          break;
        case 'speaking':
          primary = '#00f0ff';
          glow = 'rgba(0, 240, 255, ';
          glowRGB = [0, 240, 255];
          break;
        default:
          primary = '#005a66';
          glow = 'rgba(0, 90, 102, ';
          glowRGB = [0, 90, 102];
      }

      const baseR = CONFIG.ORB_BASE_RADIUS;
      const energyScale = 1 + this.energy * 0.4;

      // ── Outer glow layers ──
      for (let i = 3; i >= 0; i--) {
        const glowR = baseR * energyScale + 18 * (i + 1);
        const grad = ctx.createRadialGradient(centerX, centerY, baseR * 0.3, centerX, centerY, glowR);
        grad.addColorStop(0, glow + (0.04 * (4 - i)) + ')');
        grad.addColorStop(1, glow + '0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Main orb with wobbly edge ──
      ctx.beginPath();
      const segments = 120;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        let wobble;
        if (this.state === 'idle') {
          wobble = Math.sin(angle * 3 + this.phase * 0.8) * 1.5 + Math.sin(this.phase * 0.5) * 2;
        } else {
          wobble =
            Math.sin(angle * 5 + this.phase * 2.2) * (3 + this.energy * 14) +
            Math.sin(angle * 7 - this.phase * 2.8) * (1.5 + this.energy * 7) +
            Math.sin(angle * 11 + this.phase * 4) * (this.energy * 4);
        }
        const r = baseR * energyScale + wobble;
        const x = centerX + Math.cos(angle) * r;
        const y = centerY + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      // Orb gradient fill
      const orbGrad = ctx.createRadialGradient(
        centerX - 15, centerY - 15, 0,
        centerX, centerY, baseR * energyScale
      );
      orbGrad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
      orbGrad.addColorStop(0.35, glow + '0.15)');
      orbGrad.addColorStop(1, glow + '0.03)');
      ctx.fillStyle = orbGrad;
      ctx.fill();

      // Orb stroke
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.7 + this.energy * 0.3;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ── Inner spinning arc (arc reactor feel) ──
      const arcSpeed = this.state === 'processing' ? this.phase * 3 : this.phase;
      ctx.beginPath();
      ctx.arc(centerX, centerY, baseR * 0.35, arcSpeed, arcSpeed + Math.PI * 1.4);
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      ctx.stroke();

      // Second inner arc (opposite direction)
      ctx.beginPath();
      ctx.arc(centerX, centerY, baseR * 0.5, -arcSpeed * 0.7, -arcSpeed * 0.7 + Math.PI * 0.8);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ── Orbiting particles ──
      for (const p of this.particles) {
        p.angle += p.speed * (1 + this.energy * 2);
        const px = centerX + Math.cos(p.angle) * (p.radius + p.drift * Math.sin(this.phase));
        const py = centerY + Math.sin(p.angle) * (p.radius + p.drift * Math.sin(this.phase));

        ctx.fillStyle = primary;
        ctx.globalAlpha = p.opacity * (0.4 + this.energy * 0.6);
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ── Frequency ring (listening / speaking) ──
      if (this.state === 'listening' || this.state === 'speaking') {
        this.drawFrequencyRing(ctx, primary, glowRGB);
      }

      // ── Processing spinner ring ──
      if (this.state === 'processing') {
        this.drawProcessingRing(ctx, primary);
      }

      requestAnimationFrame(() => this.animate());
    },

    drawFrequencyRing(ctx, color, rgb) {
      let freqData;
      try {
        freqData = AudioCapture.getFrequencyData();
      } catch (e) {
        return;
      }

      const barCount = 72;
      const radius = CONFIG.ORB_BASE_RADIUS * 1.35;

      for (let i = 0; i < barCount; i++) {
        const freqIndex = Math.floor((i * freqData.length) / barCount);
        const val = freqData[freqIndex] / 255;
        const barHeight = val * 35;
        const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;

        const x1 = this.centerX + Math.cos(angle) * radius;
        const y1 = this.centerY + Math.sin(angle) * radius;
        const x2 = this.centerX + Math.cos(angle) * (radius + barHeight);
        const y2 = this.centerY + Math.sin(angle) * (radius + barHeight);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.25 + val * 0.65})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    },

    drawProcessingRing(ctx, color) {
      const radius = CONFIG.ORB_BASE_RADIUS * 1.2;
      const dotCount = 12;
      const spin = this.phase * 2;

      for (let i = 0; i < dotCount; i++) {
        const angle = (i / dotCount) * Math.PI * 2 + spin;
        const x = this.centerX + Math.cos(angle) * radius;
        const y = this.centerY + Math.sin(angle) * radius;
        const fade = (Math.sin(angle - spin + this.phase * 3) + 1) / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.15 + fade * 0.7;
        ctx.beginPath();
        ctx.arc(x, y, 2 + fade * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSCRIPT UI
  // ═══════════════════════════════════════════════════════════════════════════

  const TranscriptUI = {
    panel: null,

    init() {
      this.panel = document.getElementById('transcript-panel');
    },

    addEntry(role, text) {
      if (!text || text.trim().length === 0) return;

      const entry = document.createElement('div');
      entry.className = `transcript-entry ${role}`;

      const prefix = document.createElement('span');
      prefix.className = 'transcript-prefix';
      prefix.textContent = role === 'user' ? 'YOU >' : 'DRISHTI >';

      entry.appendChild(prefix);
      entry.appendChild(document.createTextNode(' ' + text));
      this.panel.appendChild(entry);

      // Keep only last 50 entries
      while (this.panel.children.length > 50) {
        this.panel.removeChild(this.panel.firstChild);
      }

      this.panel.scrollTop = this.panel.scrollHeight;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN CONTROLLER
  // ═══════════════════════════════════════════════════════════════════════════

  const Jarvis = {
    vadMode: true,
    playbackContext: null,
    currentQueue: null,

    async init() {
      TranscriptUI.init();

      try {
        await AudioCapture.init();

        // Create playback context (separate from capture to avoid feedback)
        this.playbackContext = new AudioContext();

        OrbVisualizer.init(document.getElementById('orb-canvas'));
        this.setupEventListeners();
        this.startClock();

        document.getElementById('net-status').classList.add('active');
        StateMachine.transition(State.IDLE);

        // Start in VAD mode
        if (this.vadMode) {
          document.getElementById('mode-toggle').classList.add('active');
          this.startVADMode();
        }

        document.getElementById('btn-label').textContent = this.vadMode ? 'VOICE ACTIVE' : 'HOLD TO SPEAK';
      } catch (err) {
        console.error('JARVIS init failed:', err);
        document.getElementById('state-label').textContent = 'MIC ERROR';
        document.getElementById('state-label').style.color = '#ff3344';
        document.getElementById('mic-status').classList.add('error');
        TranscriptUI.addEntry('assistant', 'I require microphone access to function. Please grant permission and reload.');
      }
    },

    setupEventListeners() {
      const btn = document.getElementById('listen-btn');

      // Push-to-talk button
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.handlePressStart();
      });
      btn.addEventListener('mouseup', (e) => {
        e.preventDefault();
        this.handlePressEnd();
      });
      btn.addEventListener('mouseleave', () => {
        if (StateMachine.current === State.LISTENING && !this.vadMode) {
          this.handlePressEnd();
        }
      });

      // Touch support
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this.handlePressStart();
      });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.handlePressEnd();
      });

      // Keyboard: spacebar
      let spaceDown = false;
      document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.repeat && !spaceDown) {
          e.preventDefault();
          spaceDown = true;
          this.handlePressStart();
        }
      });
      document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
          e.preventDefault();
          spaceDown = false;
          this.handlePressEnd();
        }
      });

      // Mode toggle
      document.getElementById('mode-toggle').addEventListener('click', () => {
        this.vadMode = !this.vadMode;
        const toggle = document.getElementById('mode-toggle');
        toggle.textContent = this.vadMode ? 'VAD' : 'PTT';
        toggle.classList.toggle('active', this.vadMode);
        document.getElementById('btn-label').textContent = this.vadMode ? 'VOICE ACTIVE' : 'HOLD TO SPEAK';

        if (this.vadMode) {
          this.startVADMode();
        } else {
          VAD.stop();
        }
      });
    },

    handlePressStart() {
      // Resume audio context on user gesture (browser autoplay policy)
      if (this.playbackContext.state === 'suspended') {
        this.playbackContext.resume();
      }
      if (AudioCapture.audioContext.state === 'suspended') {
        AudioCapture.audioContext.resume();
      }

      if (StateMachine.current === State.SPEAKING) {
        // Interrupt current speech
        if (this.currentQueue) this.currentQueue.clear();
        this.startListening();
        return;
      }

      if (StateMachine.current === State.IDLE) {
        if (!this.vadMode) {
          this.startListening();
        }
      }
    },

    handlePressEnd() {
      if (StateMachine.current === State.LISTENING && !this.vadMode) {
        this.stopListeningAndProcess();
      }
    },

    startVADMode() {
      if (StateMachine.current !== State.IDLE) return;

      VAD.start({
        onSpeechStart: () => {
          if (StateMachine.current === State.IDLE) {
            // Resume context on VAD trigger
            if (this.playbackContext.state === 'suspended') {
              this.playbackContext.resume();
            }
            this.startListening();
          }
        },
        onSpeechEnd: () => {
          if (StateMachine.current === State.LISTENING) {
            this.stopListeningAndProcess();
          }
        },
      });
    },

    startListening() {
      VAD.stop();
      AudioCapture.startRecording();
      StateMachine.transition(State.LISTENING);
      OrbVisualizer.setState('listening');
    },

    async stopListeningAndProcess() {
      StateMachine.transition(State.PROCESSING);
      OrbVisualizer.setState('processing');
      OrbVisualizer.setEnergy(0.3); // Gentle processing pulse

      const audioBlob = await AudioCapture.stopRecording();
      if (!audioBlob) {
        this.returnToIdle();
        return;
      }

      try {
        // ── Step 1: Transcribe ──
        const { text } = await API.transcribe(audioBlob);
        if (!text || text.trim().length === 0) {
          this.returnToIdle();
          return;
        }

        TranscriptUI.addEntry('user', text);

        // ── Step 2: Chat Stream → Sentence TTS Pipeline ──
        const audioQueue = new AudioQueueManager(this.playbackContext);
        this.currentQueue = audioQueue;
        let sentenceCount = 0;
        const ttsPromises = [];

        const fullText = await API.chatStream(text, (sentenceData) => {
          if (sentenceData.text && sentenceData.text.trim().length > 0) {
            sentenceCount++;
            const idx = sentenceData.index;

            // Fire TTS request immediately (don't await it)
            const ttsPromise = API.tts(sentenceData.text, idx)
              .then((mp3Bytes) => this.playbackContext.decodeAudioData(mp3Bytes))
              .then((audioBuffer) => {
                // Transition to speaking on first chunk
                if (idx === 0) {
                  StateMachine.transition(State.SPEAKING);
                  OrbVisualizer.setState('speaking');
                }
                audioQueue.enqueue(idx, audioBuffer);
              })
              .catch((err) => {
                console.error(`TTS error for sentence ${idx}:`, err);
              });

            ttsPromises.push(ttsPromise);
          }

          if (sentenceData.done) {
            // Wait for all TTS requests to at least be sent, then mark complete
            Promise.all(ttsPromises).then(() => {
              audioQueue.markAllEnqueued(sentenceCount);
            });
          }
        });

        TranscriptUI.addEntry('assistant', fullText);

        // Wait for all audio to finish playing
        await audioQueue.waitForCompletion();
      } catch (err) {
        console.error('Pipeline error:', err);
        TranscriptUI.addEntry('assistant', 'I encountered an error. ' + err.message);
      }

      this.currentQueue = null;
      this.returnToIdle();
    },

    returnToIdle() {
      StateMachine.transition(State.IDLE);
      OrbVisualizer.setState('idle');
      OrbVisualizer.setEnergy(0);

      if (this.vadMode) {
        this.startVADMode();
      }
    },

    startClock() {
      const clock = document.getElementById('clock');
      const update = () => {
        const now = new Date();
        clock.textContent = now.toLocaleTimeString('en-US', { hour12: false });
      };
      update();
      setInterval(update, 1000);
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    Jarvis.init();
  });
})();
