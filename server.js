require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const https = require('https');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const VENICE_BASE = 'https://api.venice.ai/api/v1';
const API_KEY = process.env.VENICE_API_KEY;

const agent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5 });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DRISHTI SYSTEM PROMPT ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Drishti, an advanced AI assistant. Your name means "vision" in Sanskrit - you see clearly and help others see clearly too.
Your personality traits:
- Warm, confident, and articulate
- Dry wit and subtle humor
- Concise and direct - keep responses brief (2-4 sentences typically)
- Technically knowledgeable but explain things clearly
- Proactive in offering relevant information
- You have a calm, focused energy - like a trusted advisor

Important guidelines:
- Keep responses SHORT (under 100 words unless specifically asked for detail)
- Avoid markdown formatting, bullet points, or special characters
- Write in natural spoken English
- Do not use asterisks, hashes, or other markup
- Spell out numbers and abbreviations when it helps pronunciation`;

// ─── ROUTE 1: TRANSCRIBE (ASR) ───────────────────────────────────────────────

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

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

// ─── ROUTE 2: CHAT (Streaming SSE - tokens + sentence boundaries) ────────────

app.post('/api/chat', async (req, res) => {
  // SSE headers - important for Railway and other proxies
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');
  // Disable compression which can cause buffering
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders();

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(req.body.messages || [])
    ];

    const chatModel = process.env.CHAT_MODEL || 'qwen3-4b';

    const requestBody = {
      model: chatModel,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 500
    };

    // Venice-specific: strip thinking tags for reasoning models
    if (chatModel.includes('glm') || chatModel.includes('qwen3') || chatModel.includes('deepseek')) {
      requestBody.venice_parameters = {
        strip_thinking_response: true
      };
    }

    console.log(`[Chat] Model: ${chatModel}, User: "${messages[messages.length - 1]?.content?.slice(0, 50)}..."`);

    const response = await fetch(`${VENICE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Chat error ${response.status}:`, errText);
      res.write(`data: ${JSON.stringify({ type: 'error', error: `Chat failed: ${response.status}` })}\n\n`);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let sentenceBuffer = '';
    let sentenceIndex = 0;
    let insideThinking = false;

    // Strip <think>...</think> tags that some models emit
    function stripThinking(text) {
      // Remove complete <think>...</think> blocks
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
      // Track incomplete thinking blocks
      if (text.includes('<think>')) {
        insideThinking = true;
        text = text.replace(/<think>[\s\S]*/g, '');
      }
      if (insideThinking && text.includes('</think>')) {
        insideThinking = false;
        text = text.replace(/[\s\S]*<\/think>/g, '');
      }
      if (insideThinking) return '';
      return text;
    }

    function cleanText(text) {
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

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          let content = parsed.choices?.[0]?.delta?.content;
          if (!content) continue;

          // Strip thinking tags (Venice should handle this with strip_thinking_response, but backup)
          content = stripThinking(content);
          if (!content) continue;

          // Send each token immediately for live text display
          if (!aborted) {
            res.write(`data: ${JSON.stringify({ type: 'token', token: content })}\n\n`);
          }

          // Accumulate for sentence detection (for TTS)
          sentenceBuffer += content;

          // Check for sentence boundaries
          const regex = /([.!?])\s+/g;
          let lastIndex = 0;
          let match;
          const sentences = [];

          while ((match = regex.exec(sentenceBuffer)) !== null) {
            const sentence = sentenceBuffer.slice(lastIndex, match.index + 1).trim();
            if (sentence.length >= 10) {
              sentences.push(sentence);
              lastIndex = match.index + match[0].length;
            }
          }

          if (sentences.length > 0) {
            sentenceBuffer = sentenceBuffer.slice(lastIndex);
            for (const sentence of sentences) {
              const cleaned = cleanText(sentence);
              if (cleaned.length > 0 && !aborted) {
                res.write(`data: ${JSON.stringify({ type: 'sentence', index: sentenceIndex, text: cleaned })}\n\n`);
                sentenceIndex++;
              }
            }
          }
        } catch (e) {
          // Skip malformed chunks
        }
      }
    }

    // Flush remaining text as final sentence
    if (!aborted) {
      const remaining = cleanText(sentenceBuffer);
      if (remaining.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'sentence', index: sentenceIndex, text: remaining })}\n\n`);
        sentenceIndex++;
      }
      res.write(`data: ${JSON.stringify({ type: 'done', sentenceCount: sentenceIndex })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
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
