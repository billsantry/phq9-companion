// server/server.js — PHQ-9 Companion (Express + static build)
// CommonJS for local + Azure compatibility. Verbose logging enabled.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ---- Config ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-chat-latest';
const PORT = process.env.PORT || 8080;

// Crisis line (single wording; UI also shows footer)
const CRISIS_REPLY =
  'If you’re not feeling safe, you deserve help right now—call or text 988 (U.S.). If danger is immediate, call 911.';

// ---- Serve static React build ----
const buildPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  console.log('✅ Serving static files from', buildPath);
} else {
  console.error('⚠️ React build not found at', buildPath, '— the app will still run but / will 404.');
}

// ---- Health checks ----
app.get('/health', (_req, res) =>
  res.json({ ok: true, model: DEFAULT_MODEL, static: fs.existsSync(buildPath) })
);
app.get('/api/llm', (_req, res) =>
  res.status(405).send('Use POST /api/llm with body: { "messages": [ { role, content }, ... ] }')
);

// ---- Helpers ----
function extractReply(d) {
  // New Responses API convenience field
  if (typeof d?.output_text === 'string' && d.output_text.trim()) return d.output_text.trim();

  // Structured Responses API shape
  if (Array.isArray(d?.output)) {
    const txt = d.output
      .flatMap((item) => (item?.content || []).map((part) => part?.text).filter(Boolean))
      .join(' ')
      .trim();
    if (txt) return txt;
  }

  // Chat Completions shape (fallback)
  if (typeof d?.choices?.[0]?.message?.content === 'string') {
    return d.choices[0].message.content.trim();
  }
  return null;
}

const RISK_PATTERNS = [
  'suicide',
  'kill myself',
  'end my life',
  'self-harm',
  'self harm',
  'hurt myself',
  'take my life',
  'better off dead',
];

function containsRiskLanguage(s) {
  const t = (s || '').toLowerCase();
  return RISK_PATTERNS.some((p) => t.includes(p));
}

// ---- Main LLM route ----
app.post('/api/llm', async (req, res) => {
  const t0 = Date.now();
  try {
    if (!OPENAI_API_KEY) {
      console.error('❌ Missing OPENAI_API_KEY');
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    }

    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      console.warn('⚠️ /api/llm called without messages');
      return res.status(400).json({ error: '"messages" array required' });
    }

    const userBlob = messages.filter((m) => m?.role === 'user').map((m) => m?.content || '').join('\n');
    const hasRisk = containsRiskLanguage(userBlob);
    console.log('ℹ️ /api/llm request', {
      count: messages.length,
      hasRisk,
      len: userBlob.length,
    });

    // Log risk but DO NOT short-circuit; let the model respond.
    // The UI will show the crisis box when safety > 0.
    if (hasRisk) {
      console.log('⚠️ Risk language present; continuing to call model so UI can handle crisis box.');
}

    // Compose input for Responses API
    const input = [
      { role: 'system', content: 'You are PHQ-9 Companion, a non-diagnostic wellbeing guide.' },
      ...messages,
    ];

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort('Timeout'), 25_000);

    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input,
        max_output_tokens: 260,
        temperature: 0.35,
      }),
      signal: ctrl.signal,
    }).catch((e) => {
      console.error('❌ Network/Fetch error to OpenAI:', e);
      throw e;
    });

    clearTimeout(timeout);

    if (!r.ok) {
      const text = await r.text().catch(() => '(no body)');
      console.error('❌ OpenAI API error', r.status, text);
      return res.status(502).json({ error: 'OpenAI error', status: r.status, body: text });
    }

    const data = await r.json().catch((e) => {
      console.error('❌ Failed to parse OpenAI JSON:', e);
      return null;
    });

    const reply = extractReply(data);
    if (!reply) {
      console.warn('⚠️ OpenAI returned no extractable text, sending fallback');
      return res.json({
        reply:
          'Thanks for completing this check-in. Consider small steps this week and when to check in with a clinician you trust.',
      });
    }

    console.log('✅ /api/llm ok in', Date.now() - t0, 'ms; chars:', reply.length);
    return res.json({ reply });
  } catch (err) {
    console.error('💥 /api/llm exception:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
});

// ---- SPA fallback (after API routes) ----
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).send('Not found');
  if (!fs.existsSync(buildPath)) return res.status(404).send('Build not found');
  res.sendFile(path.join(buildPath, 'index.html'));
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`✅ PHQ-9 Companion running on http://localhost:${PORT}  model=${DEFAULT_MODEL}`);
});
