(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    SPEECH_THRESHOLD: 0.018,
    SILENCE_THRESHOLD: 0.009,
    SILENCE_DURATION: 900,
    MIN_RECORDING_DURATION: 350,
    FFT_SIZE: 2048,
    ORB_BASE_RADIUS: 75,
    PARTICLE_COUNT: 45,
    MAX_HISTORY: 20,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS MANAGER
  // ═══════════════════════════════════════════════════════════════════════════

  const Settings = {
    model: 'grok-41-fast',
    voice: 'am_adam',
    webSearch: true,

    MODEL_INFO: {
      'grok-41-fast': 'xAI Grok 4.1 - Best for agentic tasks, vision support',
      'qwen3-4b': 'Venice Small - Fastest, lowest latency',
      'qwen3-next-80b': 'Qwen 3 Next 80B - Advanced reasoning',
      'zai-org-glm-4.7-flash': 'GLM 4.7 Flash - Fast with good reasoning',
      'zai-org-glm-4.7': 'GLM 4.7 - Most intelligent, 198K context',
      'llama-3.3-70b': 'Meta Llama 3.3 70B - Great all-rounder',
      'deepseek-v3.2': 'DeepSeek v3.2 - Strong reasoning',
      'mistral-31-24b': 'Mistral 31 24B - Fast and capable',
      'gemini-3-flash-preview': 'Google Gemini 3 Flash - Multimodal preview',
      'kimi-k2-5': 'Kimi K2.5 - Moonshot AI reasoning model',
      'claude-sonnet-45': 'Anthropic Claude Sonnet 4.5 - High quality',
      'venice-uncensored': 'Venice Uncensored - Maximum creative freedom',
    },

    init() {
      // Load saved settings
      const saved = localStorage.getItem('drishti-settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          this.model = parsed.model || this.model;
          this.voice = parsed.voice || this.voice;
          this.webSearch = parsed.webSearch !== false;
        } catch (e) {}
      }

      // Apply to UI
      const modelSelect = document.getElementById('model-select');
      const voiceSelect = document.getElementById('voice-select');
      const webSearchToggle = document.getElementById('web-search-toggle');
      if (modelSelect) modelSelect.value = this.model;
      if (voiceSelect) voiceSelect.value = this.voice;
      if (webSearchToggle) webSearchToggle.checked = this.webSearch;
      this.updateModelInfo();
    },

    save() {
      localStorage.setItem('drishti-settings', JSON.stringify({
        model: this.model,
        voice: this.voice,
        webSearch: this.webSearch,
      }));
    },

    setModel(model) {
      this.model = model;
      this.save();
      this.updateModelInfo();
    },

    setVoice(voice) {
      this.voice = voice;
      this.save();
    },

    setWebSearch(enabled) {
      this.webSearch = enabled;
      this.save();
    },

    updateModelInfo() {
      const info = document.getElementById('model-info');
      if (info) {
        info.textContent = this.MODEL_INFO[this.model] || 'Select a model';
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE MACHINE
  // ═══════════════════════════════════════════════════════════════════════════

  const State = {
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    STREAMING: 'streaming',
    SPEAKING: 'speaking',
  };

  const StateMachine = {
    current: State.IDLE,
    listeners: [],

    transition(newState) {
      if (this.current === newState) return;
      this.current = newState;
      this.listeners.forEach((fn) => fn(newState));
      this.updateUI(newState);
    },

    onChange(fn) { this.listeners.push(fn); },

    updateUI(state) {
      const label = document.getElementById('state-label');
      const stateText = {
        [State.IDLE]: 'STANDBY',
        [State.LISTENING]: 'LISTENING',
        [State.PROCESSING]: 'PROCESSING',
        [State.STREAMING]: 'STREAMING',
        [State.SPEAKING]: 'SPEAKING',
      };
      label.textContent = stateText[state] || state.toUpperCase();
      label.className = 'state-label ' + state;

      const mic = document.getElementById('mic-status');
      const ai = document.getElementById('ai-status');
      mic.className = 'indicator' + (state === State.LISTENING ? ' active' : '');
      ai.className = 'indicator' + (state === State.PROCESSING ? ' warning' : (state === State.STREAMING || state === State.SPEAKING) ? ' active' : '');

      const listenBtn = document.getElementById('listen-btn');
      listenBtn.classList.toggle('active', state === State.LISTENING);

      // Update mic ring animation
      const micRing = document.getElementById('mic-ring');
      if (micRing) {
        micRing.className = 'mic-ring';
        if (state === State.LISTENING) micRing.classList.add('listening');
        else if (state === State.PROCESSING) micRing.classList.add('processing');
      }
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
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.audioContext = new AudioContext();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = CONFIG.FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.3;
      this.sourceNode.connect(this.analyser);

      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      this.mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      return this.analyser;
    },

    startRecording() {
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType || undefined,
        audioBitsPerSecond: 32000,
      });
      this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
      this.recordingStartTime = Date.now();
      this.recorder.start();
    },

    stopRecording() {
      return new Promise((resolve) => {
        if (!this.recorder || this.recorder.state !== 'recording') { resolve(null); return; }
        if (Date.now() - this.recordingStartTime < CONFIG.MIN_RECORDING_DURATION) {
          this.recorder.stop();
          resolve(null);
          return;
        }
        this.recorder.onstop = () => {
          resolve(new Blob(this.chunks, { type: this.mimeType || 'audio/webm' }));
        };
        this.recorder.stop();
      });
    },

    getRMSLevel() {
      const data = new Float32Array(this.analyser.frequencyBinCount);
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / data.length);
    },

    getFrequencyData() {
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      return data;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // WAV ENCODER
  // ═══════════════════════════════════════════════════════════════════════════

  const WavEncoder = {
    async blobToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new OfflineAudioContext(1, 1, 16000);
      let audioBuffer;
      try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      } catch (e) {
        console.error('Audio decode failed:', e);
        throw new Error('Audio decode failed');
      }
      const targetRate = 16000;
      const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetRate), targetRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineCtx.destination);
      source.start(0);
      const resampled = await offlineCtx.startRendering();
      return this.encodeWAV(resampled);
    },

    encodeWAV(audioBuffer) {
      const samples = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const dataSize = samples.length * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const v = new DataView(buffer);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
      w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
      v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, dataSize, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
      return new Blob([buffer], { type: 'audio/wav' });
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // VAD (Voice Activity Detection)
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

    stop() { this.enabled = false; this.speechDetected = false; },

    monitor() {
      if (!this.enabled) return;
      const rms = AudioCapture.getRMSLevel();
      OrbVisualizer.setEnergy(rms * 12);

      if (rms > CONFIG.SPEECH_THRESHOLD) {
        if (!this.speechDetected) { this.speechDetected = true; if (this.onSpeechStart) this.onSpeechStart(); }
        this.silenceStart = 0;
      } else if (rms < CONFIG.SILENCE_THRESHOLD && this.speechDetected) {
        if (this.silenceStart === 0) this.silenceStart = Date.now();
        else if (Date.now() - this.silenceStart > CONFIG.SILENCE_DURATION) {
          this.speechDetected = false; this.silenceStart = 0;
          if (this.onSpeechEnd) this.onSpeechEnd();
        }
      }
      requestAnimationFrame(() => this.monitor());
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // API CLIENT
  // ═══════════════════════════════════════════════════════════════════════════

  const API = {
    conversationHistory: [],
    activeChatController: null,

    cancelActiveChat() {
      if (this.activeChatController) {
        this.activeChatController.abort();
        this.activeChatController = null;
      }
    },

    async transcribe(audioBlob) {
      const wavBlob = await WavEncoder.blobToWav(audioBlob);
      const formData = new FormData();
      formData.append('audio', wavBlob, 'recording.wav');
      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Transcription failed: ${res.status}`);
      }
      return res.json();
    },

    /**
     * Stream chat response. Calls onToken for each text token (for live display)
     * and onSentence for each complete sentence (for optional TTS).
     * Returns the full response text.
     */
    async chatStream(userText, { onToken, onSentence, onDone }) {
      this.conversationHistory.push({ role: 'user', content: userText });
      if (this.conversationHistory.length > CONFIG.MAX_HISTORY) {
        this.conversationHistory = this.conversationHistory.slice(-CONFIG.MAX_HISTORY);
      }

      this.cancelActiveChat();
      const controller = new AbortController();
      this.activeChatController = controller;

      let fullResponse = '';

      const handleSSELine = (rawLine) => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;

        let data;
        try {
          data = JSON.parse(payload);
        } catch (e) {
          return;
        }

        if (data.type === 'error') throw new Error(data.error);
        if (data.type === 'token') {
          fullResponse += data.token;
          if (onToken) onToken(data.token);
        }
        if (data.type === 'sentence' && onSentence) onSentence(data);
        if (data.type === 'done' && onDone) onDone(data);
      };

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: this.conversationHistory,
            model: Settings.model,
            webSearch: Settings.webSearch,
          }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`Chat failed: ${res.status}`);

        // Fallback for environments where streaming response bodies are not exposed.
        if (!res.body || typeof res.body.getReader !== 'function') {
          const text = await res.text();
          text.split('\n').forEach(handleSSELine);
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            lines.forEach(handleSSELine);
          }

          buffer += decoder.decode();
          if (buffer.trim().length > 0) {
            buffer.split('\n').forEach(handleSSELine);
          }
        }

        this.conversationHistory.push({ role: 'assistant', content: fullResponse });
        return fullResponse;
      } catch (err) {
        if (controller.signal.aborted) throw new Error('Chat stream interrupted');
        throw err;
      } finally {
        if (this.activeChatController === controller) this.activeChatController = null;
      }
    },

    async tts(text, index) {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, index, voice: Settings.voice }),
      });
      if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
      return res.arrayBuffer();
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIO QUEUE MANAGER (for TTS playback)
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
        if (!this.queue.has(this.nextPlayIndex)) { this.isPlaying = false; this.checkCompletion(); }
        this.tryPlayNext();
      };
      this.tryPlayNext();
    }

    checkCompletion() {
      if (this.allEnqueued && this.nextPlayIndex >= this.totalExpected && !this.isPlaying) {
        if (this.completionResolve) { this.completionResolve(); this.completionResolve = null; }
      }
    }

    waitForCompletion() {
      return new Promise((resolve) => { this.completionResolve = resolve; this.checkCompletion(); });
    }

    clear() {
      this.queue.clear();
      this.nextPlayIndex = 0;
      this.isPlaying = false;
      this.scheduledEndTime = 0;
      this.allEnqueued = false;
      this.totalExpected = -1;
      if (this.completionResolve) { this.completionResolve(); this.completionResolve = null; }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORB VISUALIZER
  // ═══════════════════════════════════════════════════════════════════════════

  const OrbVisualizer = {
    canvas: null, ctx: null, state: 'idle',
    energy: 0, targetEnergy: 0, phase: 0,
    particles: [], centerX: 0, centerY: 0, width: 0, height: 0,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      this.initParticles(CONFIG.PARTICLE_COUNT);
      this.animate();
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.width = rect.width; this.height = rect.height;
      this.canvas.width = rect.width * dpr; this.canvas.height = rect.height * dpr;
      this.ctx.scale(dpr, dpr);
      this.centerX = rect.width / 2; this.centerY = rect.height / 2;
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

    setState(s) { this.state = s; },
    setEnergy(v) { this.targetEnergy = Math.min(1, Math.max(0, v)); },

    animate() {
      const { ctx, width, height, centerX, centerY } = this;
      ctx.clearRect(0, 0, width, height);
      this.energy += (this.targetEnergy - this.energy) * 0.12;
      this.phase += 0.015;
      if (this.state === 'idle') this.targetEnergy *= 0.95;

      let primary, glow, glowRGB;
      switch (this.state) {
        case 'listening': primary = '#00f0ff'; glow = 'rgba(0,240,255,'; glowRGB = [0,240,255]; break;
        case 'processing': primary = '#ff9500'; glow = 'rgba(255,149,0,'; glowRGB = [255,149,0]; break;
        case 'streaming': primary = '#00ff88'; glow = 'rgba(0,255,136,'; glowRGB = [0,255,136]; break;
        case 'speaking': primary = '#00f0ff'; glow = 'rgba(0,240,255,'; glowRGB = [0,240,255]; break;
        default: primary = '#005a66'; glow = 'rgba(0,90,102,'; glowRGB = [0,90,102];
      }

      const baseR = CONFIG.ORB_BASE_RADIUS;
      const eScale = 1 + this.energy * 0.4;

      // Glow layers
      for (let i = 3; i >= 0; i--) {
        const gr = baseR * eScale + 18 * (i + 1);
        const g = ctx.createRadialGradient(centerX, centerY, baseR * 0.3, centerX, centerY, gr);
        g.addColorStop(0, glow + (0.04 * (4 - i)) + ')');
        g.addColorStop(1, glow + '0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(centerX, centerY, gr, 0, Math.PI * 2); ctx.fill();
      }

      // Orb body
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 2;
        const w = this.state === 'idle'
          ? Math.sin(a * 3 + this.phase * 0.8) * 1.5 + Math.sin(this.phase * 0.5) * 2
          : Math.sin(a * 5 + this.phase * 2.2) * (3 + this.energy * 14) +
            Math.sin(a * 7 - this.phase * 2.8) * (1.5 + this.energy * 7) +
            Math.sin(a * 11 + this.phase * 4) * (this.energy * 4);
        const r = baseR * eScale + w;
        const x = centerX + Math.cos(a) * r, y = centerY + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      const og = ctx.createRadialGradient(centerX - 15, centerY - 15, 0, centerX, centerY, baseR * eScale);
      og.addColorStop(0, 'rgba(255,255,255,0.08)'); og.addColorStop(0.35, glow + '0.15)'); og.addColorStop(1, glow + '0.03)');
      ctx.fillStyle = og; ctx.fill();
      ctx.strokeStyle = primary; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7 + this.energy * 0.3; ctx.stroke(); ctx.globalAlpha = 1;

      // Inner arcs
      const as = this.state === 'processing' ? this.phase * 3 : this.phase;
      ctx.beginPath(); ctx.arc(centerX, centerY, baseR * 0.35, as, as + Math.PI * 1.4);
      ctx.strokeStyle = primary; ctx.lineWidth = 1; ctx.globalAlpha = 0.35; ctx.stroke();
      ctx.beginPath(); ctx.arc(centerX, centerY, baseR * 0.5, -as * 0.7, -as * 0.7 + Math.PI * 0.8); ctx.stroke(); ctx.globalAlpha = 1;

      // Particles
      for (const p of this.particles) {
        p.angle += p.speed * (1 + this.energy * 2);
        const px = centerX + Math.cos(p.angle) * (p.radius + p.drift * Math.sin(this.phase));
        const py = centerY + Math.sin(p.angle) * (p.radius + p.drift * Math.sin(this.phase));
        ctx.fillStyle = primary; ctx.globalAlpha = p.opacity * (0.4 + this.energy * 0.6);
        ctx.beginPath(); ctx.arc(px, py, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Frequency ring
      if (this.state === 'listening' || this.state === 'speaking') {
        try {
          const fd = AudioCapture.getFrequencyData();
          const bc = 72, rad = CONFIG.ORB_BASE_RADIUS * 1.35;
          for (let i = 0; i < bc; i++) {
            const fi = Math.floor((i * fd.length) / bc), val = fd[fi] / 255, bh = val * 35;
            const ang = (i / bc) * Math.PI * 2 - Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(centerX + Math.cos(ang) * rad, centerY + Math.sin(ang) * rad);
            ctx.lineTo(centerX + Math.cos(ang) * (rad + bh), centerY + Math.sin(ang) * (rad + bh));
            ctx.strokeStyle = `rgba(${glowRGB[0]},${glowRGB[1]},${glowRGB[2]},${0.25 + val * 0.65})`;
            ctx.lineWidth = 1.5; ctx.stroke();
          }
        } catch (e) {}
      }

      // Processing ring
      if (this.state === 'processing') {
        const rad = CONFIG.ORB_BASE_RADIUS * 1.2, dc = 12, sp = this.phase * 2;
        for (let i = 0; i < dc; i++) {
          const a = (i / dc) * Math.PI * 2 + sp;
          const fade = (Math.sin(a - sp + this.phase * 3) + 1) / 2;
          ctx.fillStyle = primary; ctx.globalAlpha = 0.15 + fade * 0.7;
          ctx.beginPath(); ctx.arc(centerX + Math.cos(a) * rad, centerY + Math.sin(a) * rad, 2 + fade * 2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Streaming pulse ring
      if (this.state === 'streaming') {
        const pulseRad = CONFIG.ORB_BASE_RADIUS * (1.15 + Math.sin(this.phase * 3) * 0.1);
        ctx.beginPath(); ctx.arc(centerX, centerY, pulseRad, 0, Math.PI * 2);
        ctx.strokeStyle = primary; ctx.lineWidth = 0.8;
        ctx.globalAlpha = 0.3 + Math.sin(this.phase * 3) * 0.2; ctx.stroke(); ctx.globalAlpha = 1;
      }

      requestAnimationFrame(() => this.animate());
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSCRIPT UI (with streaming text support)
  // ═══════════════════════════════════════════════════════════════════════════

  const TranscriptUI = {
    panel: null,
    activeEntry: null, // currently streaming entry

    init() { this.panel = document.getElementById('transcript-panel'); },

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
      this.trimEntries();
      this.panel.scrollTop = this.panel.scrollHeight;
    },

    // Start a streaming entry (for assistant responses)
    startStreaming() {
      const entry = document.createElement('div');
      entry.className = 'transcript-entry assistant streaming';
      const prefix = document.createElement('span');
      prefix.className = 'transcript-prefix';
      prefix.textContent = 'DRISHTI >';
      const textSpan = document.createElement('span');
      textSpan.className = 'streaming-text';
      entry.appendChild(prefix);
      entry.appendChild(document.createTextNode(' '));
      entry.appendChild(textSpan);
      this.panel.appendChild(entry);
      this.activeEntry = textSpan;
      this.panel.scrollTop = this.panel.scrollHeight;
    },

    // Append a token to the active streaming entry
    appendToken(token) {
      if (!this.activeEntry) return;
      this.activeEntry.textContent += token;
      this.panel.scrollTop = this.panel.scrollHeight;
    },

    // Finalize the streaming entry
    endStreaming() {
      if (this.activeEntry) {
        this.activeEntry.parentElement.classList.remove('streaming');
        this.activeEntry = null;
      }
      this.trimEntries();
    },

    trimEntries() {
      while (this.panel.children.length > 50) this.panel.removeChild(this.panel.firstChild);
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN CONTROLLER
  // ═══════════════════════════════════════════════════════════════════════════

  const Drishti = {
    ttsEnabled: false,
    playbackContext: null,
    currentQueue: null,
    pipelineBusy: false,
    interactionVersion: 0,

    async init() {
      TranscriptUI.init();
      Settings.init();

      try {
        await AudioCapture.init();
        this.playbackContext = new AudioContext();
        OrbVisualizer.init(document.getElementById('orb-canvas'));
        this.setupEventListeners();
        this.startClock();

        document.getElementById('net-status').classList.add('active');
        StateMachine.transition(State.IDLE);

        document.getElementById('btn-label').textContent = 'HOLD TO SPEAK';
      } catch (err) {
        console.error('Drishti init failed:', err);
        document.getElementById('state-label').textContent = 'MIC ERROR';
        document.getElementById('state-label').style.color = '#ff3344';
        document.getElementById('mic-status').classList.add('error');
        TranscriptUI.addEntry('assistant', 'I require microphone access to function. Please grant permission and reload.');
      }
    },

    setupEventListeners() {
      const btn = document.getElementById('listen-btn');

      // Push-to-talk
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); this.handlePressStart(); });
      btn.addEventListener('mouseup', (e) => { e.preventDefault(); this.handlePressEnd(); });
      btn.addEventListener('mouseleave', () => {
        if (StateMachine.current === State.LISTENING) this.handlePressEnd();
      });
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); this.handlePressStart(); });
      btn.addEventListener('touchend', (e) => { e.preventDefault(); this.handlePressEnd(); });

      // Spacebar
      let spaceDown = false;
      document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.repeat && !spaceDown) {
          e.preventDefault(); spaceDown = true; this.handlePressStart();
        }
      });
      document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') { e.preventDefault(); spaceDown = false; this.handlePressEnd(); }
      });

      // TTS toggle
      document.getElementById('tts-toggle').addEventListener('click', () => {
        this.ttsEnabled = !this.ttsEnabled;
        const ttsBtn = document.getElementById('tts-toggle');
        ttsBtn.classList.toggle('active', this.ttsEnabled);
      });

      // Settings panel
      const settingsPanel = document.getElementById('settings-panel');
      const settingsBtn = document.getElementById('settings-btn');
      const settingsClose = document.getElementById('settings-close');
      const modelSelect = document.getElementById('model-select');
      const voiceSelect = document.getElementById('voice-select');

      settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('open');
      });

      settingsClose.addEventListener('click', () => {
        settingsPanel.classList.remove('open');
      });

      modelSelect.addEventListener('change', (e) => {
        Settings.setModel(e.target.value);
      });

      voiceSelect.addEventListener('change', (e) => {
        Settings.setVoice(e.target.value);
      });

      const webSearchToggle = document.getElementById('web-search-toggle');
      if (webSearchToggle) {
        webSearchToggle.addEventListener('change', (e) => {
          Settings.setWebSearch(e.target.checked);
        });
      }

      // Close settings when clicking outside
      document.addEventListener('click', (e) => {
        if (!settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
          settingsPanel.classList.remove('open');
        }
      });
    },

    handlePressStart() {
      if (this.pipelineBusy) return;
      if (this.playbackContext.state === 'suspended') this.playbackContext.resume();
      if (AudioCapture.audioContext.state === 'suspended') AudioCapture.audioContext.resume();

      if (StateMachine.current === State.IDLE) {
        this.startListening();
      }
    },

    handlePressEnd() {
      if (StateMachine.current === State.LISTENING) this.stopListeningAndProcess();
    },

    startListening() {
      this.interactionVersion++;
      VAD.stop();
      AudioCapture.startRecording();
      StateMachine.transition(State.LISTENING);
      OrbVisualizer.setState('listening');
    },

    async stopListeningAndProcess() {
      if (this.pipelineBusy) return;
      this.pipelineBusy = true;
      const runVersion = this.interactionVersion;

      try {
        StateMachine.transition(State.PROCESSING);
        OrbVisualizer.setState('processing');
        OrbVisualizer.setEnergy(0.3);

        const audioBlob = await AudioCapture.stopRecording();
        if (!audioBlob) return;

        // Step 1: Transcribe
        const { text } = await API.transcribe(audioBlob);
        if (!text || text.trim().length === 0) return;
        TranscriptUI.addEntry('user', text);

        // Step 2: Stream chat response
        StateMachine.transition(State.STREAMING);
        OrbVisualizer.setState('streaming');
        OrbVisualizer.setEnergy(0.2);
        TranscriptUI.startStreaming();

        // TTS setup (only if enabled)
        let audioQueue = null;
        let sentenceCount = 0;
        const ttsPromises = [];

        if (this.ttsEnabled) {
          audioQueue = new AudioQueueManager(this.playbackContext);
          this.currentQueue = audioQueue;
        }

        await API.chatStream(text, {
          onToken: (token) => {
            TranscriptUI.appendToken(token);
            OrbVisualizer.setEnergy(0.15 + Math.random() * 0.1);
          },

          onSentence: (data) => {
            if (!this.ttsEnabled || !audioQueue) return;
            sentenceCount++;
            const idx = data.index;
            const ttsP = API.tts(data.text, idx)
              .then((mp3) => this.playbackContext.decodeAudioData(mp3))
              .then((buf) => {
                if (idx === 0) {
                  StateMachine.transition(State.SPEAKING);
                  OrbVisualizer.setState('speaking');
                }
                audioQueue.enqueue(idx, buf);
              })
              .catch((err) => console.error(`TTS error sentence ${idx}:`, err));
            ttsPromises.push(ttsP);
          },

          onDone: (data) => {
            TranscriptUI.endStreaming();
            if (this.ttsEnabled && audioQueue) {
              Promise.all(ttsPromises).then(() => {
                audioQueue.markAllEnqueued(data.sentenceCount || sentenceCount);
              });
            }
          },
        });

        // If TTS enabled, wait for audio to finish
        if (this.ttsEnabled && audioQueue) {
          await audioQueue.waitForCompletion();
        }
      } catch (err) {
        console.error('Pipeline error:', err);
        TranscriptUI.endStreaming();
        TranscriptUI.addEntry('assistant', 'Error: ' + err.message);
      } finally {
        this.currentQueue = null;
        this.pipelineBusy = false;
        if (runVersion === this.interactionVersion) this.returnToIdle();
      }
    },

    returnToIdle() {
      StateMachine.transition(State.IDLE);
      OrbVisualizer.setState('idle');
      OrbVisualizer.setEnergy(0);
    },

    startClock() {
      const clock = document.getElementById('clock');
      const update = () => { clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false }); };
      update(); setInterval(update, 1000);
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => Drishti.init());
})();
