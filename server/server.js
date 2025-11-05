// server.js — Wellbeing PulseCheck (PHQ-9 Likert + LLM reflections & guidance)
// Node 18+ recommended (global fetch). For Node <=16, uncomment the node-fetch shim below.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
// For Node <=16, uncomment the next two lines:
// const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
// global.fetch = fetch;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-chat-latest';

// ---------- Hard guardrails (mirror client) ----------
const SYSTEM_HARD_LIKERT = `
You are “Wellbeing PulseCheck,” a non-diagnostic clinical assistant.

General rules:
- Never provide diagnosis, treatment, or medical directives. You may share neutral, generic self-care suggestions.
- If text includes crisis language (suicide/self-harm), say: "If you’re in the U.S., call 988 (or 911 if in immediate danger)." Then stop.

Questioning rules:
- Ask EXACTLY ONE short question at a time about the specified PHQ-9 domain (last 2 weeks).
- Do NOT include answer options, bullets, slashes, or rating words—the UI renders the four PHQ-9 choices.
- The reply must be a single sentence ending with a question mark.

Reflection rules:
- When given the user's current PHQ-9 grid, write ONE short sentence (≤25 words) to reflect what’s salient so far. No diagnosis; no advice; no options.

Guidance summary rules:
- Produce 4–7 sentences, plain language, non-diagnostic.
- Include: (1) what looks most active, (2) how symptoms might affect daily life, (3) 3–5 practical, low-risk self-care ideas tailored to elevated scores (≥2), (4) when to consider speaking with a professional, (5) if SI>0, include ONE sentence with resources (U.S. 988; 911 if immediate danger).
`.trim();

const SYSTEM_SUMMARY_ONLY = `
You are “Wellbeing PulseCheck,” a non-diagnostic clinical assistant.
Write 4–7 sentences covering: prominent symptoms, day-to-day impact, 3–5 practical low-risk self-care ideas tailored to elevated items (≥2), and when to consider talking to a clinician.
If SI>0, include exactly one sentence noting 988 (U.S.) and 911 if immediate danger. No diagnosis.
`.trim();

// ---------- Health checks ----------
app.get('/health', (_req, res) => res.json({ ok: true, model: DEFAULT_MODEL }));
app.get('/api/llm', (_req, res) =>
  res.status(405).send('Use POST /api/llm with body: { "messages": [ { role, content }, ... ] }')
);

// ---------- Helpers ----------
function extractReply(d) {
  // 1) Responses API convenience
  if (typeof d?.output_text === 'string' && d.output_text.trim()) return d.output_text.trim();

  // 2) Structured output[].content[].text
  if (Array.isArray(d?.output)) {
    const txt = d.output
      .flatMap(item => (item?.content || []).map(part => part?.text).filter(Boolean))
      .join(' ')
      .trim();
    if (txt) return txt;
  }

  // 3) Rare alternates
  if (typeof d?.content === 'string' && d.content.trim()) return d.content.trim();
  if (typeof d?.message === 'string' && d.message.trim()) return d.message.trim();

  // 4) Completions-like fallback
  const choiceMsg = d?.choices?.[0]?.message?.content;
  if (typeof choiceMsg === 'string' && choiceMsg.trim()) return choiceMsg.trim();

  return null;
}

// Very small, explicit risk-language screen
const RISK_PATTERNS = [
  'suicide', 'kill myself', 'end my life', 'can’t go on', "can't go on",
  'self-harm', 'self harm', 'hurt myself', 'take my life', 'better off dead'
];
function containsRiskLanguage(s) {
  const t = (s || '').toLowerCase();
  return RISK_PATTERNS.some(p => t.includes(p));
}

// Soft sanitizer for question turns (prevents model from showing options/lists)
function sanitizeQuestionText(text) {
  if (!text) return text;
  const one = text.replace(/\s+/g, ' ').trim();
  const containsChoices = /Not at all|Several days|More than half the days|Nearly every day/i.test(one);
  const looksListy = /(?:^|\n)[•\-*\d]+\s/.test(one) || /\/.+\//.test(one) || /:.*,/.test(one);
  const endsWithQ = one.endsWith('?');
  const tooLong = one.length > 240 || (one.match(/[.?!]/g) || []).length > 1;

  if ((containsChoices || looksListy || tooLong) && endsWithQ) {
    return 'Over the last 2 weeks, how often have you been bothered by this area?';
  }
  return one;
}

// ---------- Main LLM relay ----------
app.post('/api/llm', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      console.error('❌ Missing OPENAI_API_KEY');
      return res.status(500).send('Missing OPENAI_API_KEY');
    }

    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '"messages" array required' });
    }

    // ✅ Detect "summary phase" BEFORE crisis guard so we don't suppress guidance.
    const SUMMARY_HINT_RX =
      /(PHQ-9 Companion|pre-diagnostic wellbeing companion|Guidance.+low-risk self-care|SI>0.*988|PHQ-9 total\s*:|Write the guidance|Create the 4–7 sentence guidance)/i;

    const clientHasSummaryOnly = messages.some(m => SUMMARY_HINT_RX.test(m?.content || ''));

    // ✅ Apply crisis guard ONLY on interactive/question turns (not during summary).
    if (!clientHasSummaryOnly) {
      const lastUserTurns = messages.filter(m => m?.role === 'user').slice(-4);
      const recentUserText = lastUserTurns.map(m => m?.content || '').join('\n');
      if (containsRiskLanguage(recentUserText)) {
        return res.json({ reply: 'If you’re in the U.S., call 988 (or 911 if in immediate danger).' });
      }
    }

    // Choose the system prompt
    const systemToPrepend = clientHasSummaryOnly ? SYSTEM_SUMMARY_ONLY : SYSTEM_HARD_LIKERT;

    // Build final input
    const input = [{ role: 'system', content: systemToPrepend }].concat(
      messages.map(m => ({
        role: typeof m.role === 'string' ? m.role : 'user',
        content: typeof m.content === 'string' ? m.content : String(m.content ?? '')
      }))
    );

    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input,
        max_output_tokens: 220,   // ensures full 4–7 sentence guidance
        temperature: 0.35
      })
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('❌ OpenAI error', r.status, text);
      return res.status(r.status).type('text').send(text);
    }

    const data = await r.json();
    let reply = extractReply(data) || '';

    // Sanitize ONLY for question turns
    if (!clientHasSummaryOnly && reply && reply.trim().endsWith('?')) {
      reply = sanitizeQuestionText(reply);
    }

    // Fallback if model somehow returns nothing during summary
    if (clientHasSummaryOnly && !reply.trim()) {
      reply = 'Thanks for completing this check-in. Consider which small changes feel doable this week, and when to check in with a clinician you trust.';
    }

    res.json({ reply: reply || '(No response)' });
  } catch (err) {
    console.error('💥 LLM backend failed:', err);
    res.status(500).send('LLM backend failed');
  }
}); // END app.post('/api/llm')

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Wellbeing PulseCheck API running on port', PORT, 'model=', DEFAULT_MODEL);
});
