require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const VENICE_BASE = 'https://api.venice.ai/api/v1';
const API_KEY = process.env.VENICE_API_KEY;

const agent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5 });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

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
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Send an immediate SSE comment so clients/proxies see body bytes right away.
  res.write(': connected\n\n');

  let aborted = false;
  let veniceReq = null;
  const pingInterval = setInterval(() => {
    if (!aborted && !res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  function abortStream(reason) {
    if (aborted) return;
    aborted = true;
    clearInterval(pingInterval);
    console.log(`[Chat] Client disconnected (${reason})`);
    if (veniceReq && !veniceReq.destroyed) {
      veniceReq.destroy(new Error('Client disconnected'));
    }
  }

  // `req.close` fires once the request body is consumed for POST requests,
  // so use response/request abort signals instead to detect real disconnects.
  req.on('aborted', () => abortStream('request aborted'));
  res.on('close', () => {
    if (!res.writableEnded) abortStream('response closed early');
  });

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(req.body.messages || [])
    ];

    // Use model from request, fall back to env var, then default
    const chatModel = req.body.model || process.env.CHAT_MODEL || 'qwen3-4b';

    const requestBody = {
      model: chatModel,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 500
    };

    // Venice-specific: strip thinking tags for reasoning models
    // Apply to all models with reasoning capability (grok, glm, qwen, deepseek, kimi, etc.)
    requestBody.venice_parameters = {
      strip_thinking_response: true
    };

    console.log(`[Chat] Model: ${chatModel}, User: "${messages[messages.length - 1]?.content?.slice(0, 50)}..."`);

    let sseBuffer = '';
    let sentenceBuffer = '';
    let sentenceIndex = 0;
    let insideThinking = false;
    let tokenCount = 0;
    let chunkCount = 0;

    // Strip <think>...</think> tags that some models emit
    function stripThinking(text) {
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
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

    // Use native https for reliable streaming
    const postData = JSON.stringify(requestBody);
    const url = new URL(`${VENICE_BASE}/chat/completions`);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      agent: agent,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept-Encoding': 'identity'
      }
    };

    veniceReq = https.request(options, (veniceRes) => {
      console.log(`[Chat] Venice responded with status: ${veniceRes.statusCode}`);
      console.log(`[Chat] Response headers:`, veniceRes.headers);
      
      if (veniceRes.statusCode !== 200) {
        let errBody = '';
        veniceRes.on('data', chunk => errBody += chunk);
        veniceRes.on('end', () => {
          console.error(`[Chat] Error: ${errBody.slice(0, 200)}`);
          res.write(`data: ${JSON.stringify({ type: 'error', error: `Chat failed: ${veniceRes.statusCode}` })}\n\n`);
          clearInterval(pingInterval);
          res.end();
        });
        return;
      }

      // Handle compressed responses
      let stream = veniceRes;
      const encoding = veniceRes.headers['content-encoding'];
      console.log(`[Chat] Content-Encoding: ${encoding || 'none'}`);
      
      if (encoding === 'gzip') {
        stream = veniceRes.pipe(zlib.createGunzip());
      } else if (encoding === 'br') {
        stream = veniceRes.pipe(zlib.createBrotliDecompress());
      } else if (encoding === 'deflate') {
        stream = veniceRes.pipe(zlib.createInflate());
      }
      
      stream.setEncoding('utf8');
      console.log('[Chat] Stream handlers being attached...');
      
      stream.on('data', (chunk) => {
        console.log(`[Chat] Data event fired, aborted=${aborted}, chunk size=${chunk.length}`);
        if (aborted) {
          console.log('[Chat] Request was aborted, skipping chunk');
          return;
        }
        
        chunkCount++;
        console.log(`[Chat] Processing chunk #${chunkCount}`);
        if (chunkCount <= 3) {
          console.log(`[Chat] Content: ${chunk.slice(0, 150).replace(/\n/g, '\\n')}`);
        }
        sseBuffer += chunk;

        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            console.log('[Chat] Received [DONE] marker');
            continue;
          }

          try {
            const parsed = JSON.parse(payload);
            let content = parsed.choices?.[0]?.delta?.content;
            if (!content) continue;

            // Strip thinking tags (Venice should handle this with strip_thinking_response, but backup)
            content = stripThinking(content);
            if (!content) continue;

            tokenCount++;
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
      });

      stream.on('end', () => {
        console.log(`[Chat] Stream finished, chunks: ${chunkCount}, tokens sent: ${tokenCount}`);
        
        // Flush remaining text as final sentence
        if (!aborted) {
          const remaining = cleanText(sentenceBuffer);
          if (remaining.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'sentence', index: sentenceIndex, text: remaining })}\n\n`);
            sentenceIndex++;
          }
          res.write(`data: ${JSON.stringify({ type: 'done', sentenceCount: sentenceIndex })}\n\n`);
        }
        clearInterval(pingInterval);
        res.end();
      });

      stream.on('error', (err) => {
        console.error('[Chat] Stream error:', err);
        if (!aborted) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
          clearInterval(pingInterval);
          res.end();
        }
      });
    });

    veniceReq.on('error', (err) => {
      console.error('[Chat] Request error:', err);
      if (!aborted) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        clearInterval(pingInterval);
        res.end();
      }
    });

    veniceReq.write(postData);
    veniceReq.end();

  } catch (err) {
    console.error('Chat error:', err);
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      clearInterval(pingInterval);
      res.end();
    }
  }
});

// ─── ROUTE 3: TTS (Text-to-Speech) ───────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  try {
    const { text, index, voice } = req.body;
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text provided' });
    }

    // Use voice from request, fall back to env var, then default
    const ttsVoice = voice || process.env.TTS_VOICE || 'am_adam';

    const response = await fetch(`${VENICE_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-kokoro',
        input: text,
        voice: ttsVoice,
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
