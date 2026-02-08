require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const https = require('https');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const VENICE_BASE = 'https://api.venice.ai/api/v1';
const API_KEY = process.env.VENICE_API_KEY;

// Keep-alive agent for connection reuse
const agent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5 });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DRISHTI SYSTEM PROMPT ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Drishti, an advanced AI assistant. Your name means "vision" in Sanskrit - you see clearly and help others see clearly too.
Your personality traits:
- Warm, confident, and articulate
- Dry wit and subtle humor
- Concise and direct - you are speaking aloud, so keep responses brief (2-4 sentences typically)
- Technically knowledgeable but explain things clearly
- Proactive in offering relevant information
- You have a calm, focused energy - like a trusted advisor

Important: Your responses will be spoken aloud via text-to-speech. Therefore:
- Keep responses SHORT (under 100 words unless specifically asked for detail)
- Avoid markdown formatting, bullet points, or special characters
- Write in natural spoken English
- Avoid parenthetical asides
- Do not use asterisks, hashes, or other markup
- Spell out numbers and abbreviations when it helps pronunciation`;

// ─── ROUTE 1: TRANSCRIBE (ASR) ───────────────────────────────────────────────

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Client now sends WAV audio (converted from webm on the client)
    const mimeType = req.file.mimetype || 'audio/wav';
    const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'wav';

    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', process.env.ASR_MODEL || 'nvidia/parakeet-tdt-0.6b-v3');
    formData.append('response_format', 'json');
    formData.append('language', 'en');

    const response = await fetch(`${VENICE_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`ASR error ${response.status}:`, errText);
      return res.status(response.status).json({ error: `Transcription failed: ${response.status}`, detail: errText });
    }

    const data = await response.json();
    res.json({ text: data.text || '' });
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE 2: CHAT (Streaming SSE with Sentence Buffering) ───────────────────

app.post('/api/chat', async (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(req.body.messages || [])
    ];

    const response = await fetch(`${VENICE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || 'qwen3-4b',
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Chat error ${response.status}:`, errText);
      res.write(`data: ${JSON.stringify({ error: `Chat failed: ${response.status}` })}\n\n`);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let sentenceBuffer = '';
    let sentenceIndex = 0;

    // Sentence boundary detection
    function extractSentences(text) {
      const sentences = [];
      // Match sentence endings: period/exclamation/question followed by space or end of string
      // But avoid splitting on common abbreviations
      const regex = /([.!?])\s+/g;
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const sentence = text.slice(lastIndex, match.index + 1).trim();
        if (sentence.length >= 15) { // Minimum sentence length to avoid tiny fragments
          sentences.push(sentence);
          lastIndex = match.index + match[0].length;
        }
      }

      const remainder = text.slice(lastIndex);
      return { sentences, remainder };
    }

    // Strip markdown/formatting that might slip through
    function cleanForTTS(text) {
      return text
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/#{1,6}\s/g, '')
        .replace(/`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
    }

    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const content = parsed.choices?.[0]?.delta?.content;
          if (!content) continue;

          sentenceBuffer += content;

          // Try to extract complete sentences
          const { sentences, remainder } = extractSentences(sentenceBuffer);
          sentenceBuffer = remainder;

          for (const sentence of sentences) {
            const cleaned = cleanForTTS(sentence);
            if (cleaned.length > 0 && !aborted) {
              res.write(`data: ${JSON.stringify({ index: sentenceIndex, text: cleaned, done: false })}\n\n`);
              sentenceIndex++;
            }
          }
        } catch (e) {
          // Skip malformed JSON chunks
        }
      }
    }

    // Flush remaining buffer as final sentence
    if (sentenceBuffer.trim().length > 0 && !aborted) {
      const cleaned = cleanForTTS(sentenceBuffer.trim());
      if (cleaned.length > 0) {
        res.write(`data: ${JSON.stringify({ index: sentenceIndex, text: cleaned, done: true })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ index: sentenceIndex, text: '', done: true })}\n\n`);
      }
    } else if (!aborted) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ─── ROUTE 3: TTS (Text-to-Speech) ───────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  try {
    const { text, index } = req.body;
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const response = await fetch(`${VENICE_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-kokoro',
        input: text,
        voice: process.env.TTS_VOICE || 'am_adam',
        response_format: 'mp3',
        speed: 1.05
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`TTS error ${response.status}:`, errText);
      return res.status(response.status).json({ error: `TTS failed: ${response.status}`, detail: errText });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Sentence-Index', String(index || 0));

    // Stream the MP3 bytes directly to client
    const arrayBuf = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuf));
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  D R I S H T I  Server Online        ║`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log(`  ║  ASR: ${(process.env.ASR_MODEL || 'parakeet').slice(0, 28).padEnd(28)}  ║`);
  console.log(`  ║  Chat: ${(process.env.CHAT_MODEL || 'qwen3-4b').padEnd(27)}  ║`);
  console.log(`  ║  Voice: ${(process.env.TTS_VOICE || 'am_adam').padEnd(26)}  ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
