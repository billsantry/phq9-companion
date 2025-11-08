import React, { useEffect, useRef, useState } from "react";

/** PHQ-9 Companion — Pre-diagnostic wellbeing companion (v8.4.1)
 *  - Filters “Safety” lines before LLM call (prevents truncation)
 *  - Keeps only modal + footer disclaimers
 *  - Verbose logging for debugging
 */

async function callLLM(messages, apiUrl = "/api/llm") {
  console.debug("[callLLM] →", messages);
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    console.error("[callLLM] HTTP", res.status, text);
    throw new Error(text || `HTTP ${res.status}`);
  }
  const json = await res.json();
  console.debug("[callLLM] ←", json);
  if (!json || typeof json.reply !== "string") throw new Error("Bad LLM payload");
  return json.reply.trim();
}

function ConsentModal({ open, onAccept }) {
  const [isAdult, setIsAdult] = useState(false);
  const [agree, setAgree] = useState(false);
  if (!open) return null;
  return (
    <div style={S.modalBackdrop}>
      <div style={S.modalCard}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Prototype notice</h2>
        <div style={S.noticeBox}>
          This tool is a prototype <strong>pre-diagnostic wellbeing companion</strong>. It does not provide a diagnosis
          or medical advice. If you’re in immediate danger, contact local emergency services. In the U.S., call{" "}
          <strong>911</strong> or <strong>988</strong>.
        </div>
        <label style={S.checkboxRow}>
          <input type="checkbox" checked={isAdult} onChange={(e) => setIsAdult(e.target.checked)} /> I am 18 or older
        </label>
        <label style={S.checkboxRow}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I understand this is a
          prototype and wish to continue
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={S.button} disabled={!(isAdult && agree)} onClick={onAccept}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- PHQ-9 domains ----
const DOMAINS = [
  { id: "interest", label: "Interest", canonical: "Over the last 2 weeks, how often have you been bothered by little interest or pleasure in doing things?" },
  { id: "mood", label: "Mood", canonical: "Over the last 2 weeks, how often have you been bothered by feeling down, depressed, or hopeless?" },
  { id: "sleep", label: "Sleep", canonical: "Over the last 2 weeks, how often have you been bothered by trouble falling or staying asleep, or sleeping too much?" },
  { id: "energy", label: "Energy", canonical: "Over the last 2 weeks, how often have you been bothered by feeling tired or having little energy?" },
  { id: "appetite", label: "Appetite", canonical: "Over the last 2 weeks, how often have you been bothered by poor appetite or overeating?" },
  { id: "self_worth", label: "Self-worth", canonical: "Over the last 2 weeks, how often have you been bothered by feeling bad about yourself—or that you are a failure or have let yourself or your family down?" },
  { id: "concentration", label: "Concentration", canonical: "Over the last 2 weeks, how often have you been bothered by trouble concentrating on things, such as reading or watching TV?" },
  { id: "psychomotor", label: "Psychomotor", canonical: "Over the last 2 weeks, how often have you been bothered by moving or speaking slowly—or being unusually fidgety or restless?" },
  { id: "si_dead", label: "Safety — better off dead", canonical: "Over the last 2 weeks, how often have you been bothered by thoughts that you would be better off dead?" },
  { id: "si_harm", label: "Safety — hurting yourself", canonical: "Over the last 2 weeks, how often have you been bothered by thoughts about intentionally harming yourself in any way?" },
];

const OPTIONS = [
  { key: "0", label: "Not at all", score: 0 },
  { key: "1", label: "Several days", score: 1 },
  { key: "2", label: "More than half the days", score: 2 },
  { key: "3", label: "Nearly every day", score: 3 },
];

function severityFromTotal(total) {
  if (total <= 4) return "Minimal (0–4)";
  if (total <= 9) return "Mild (5–9)";
  if (total <= 14) return "Moderate (10–14)";
  if (total <= 19) return "Moderately severe (15–19)";
  return "Severe (20–27)";
}

// ---- Focused system prompt ----
const SYSTEM_SUMMARY_ONLY = `
You are “PHQ-9 Companion,” a friendly wellbeing reflection guide.
Write two short paragraphs (4–7 sentences total) summarizing the person’s recent mood and energy patterns.

Do all of the following:
• Reflect what may be most challenging right now in everyday language.
• Identify 2–3 key patterns (e.g., low energy, restless sleep, difficulty focusing).
• Describe how these may affect motivation, relationships, or work.
• Offer 3–5 gentle, low-risk wellbeing ideas (sleep routine, short walks, journaling, balanced meals, mindful breaks).
• Keep tone warm and supportive. Avoid any phone numbers or crisis text.
• End with a motivating line (“small changes add up,” “you deserve care,” etc.).
`.trim();

// ---- Text helpers ----
function makeRecapParts(text) {
  return String(text)
    .split("\n")
    .map((t) => ({ text: t, bold: /(988|911)/i.test(t), block: true }));
}

function makeGuidanceParts(t, { omitCrisis } = {}) {
  const crisis = /(988|911|immediate danger)/i;
  const paras = String(t).trim().split(/\n\s*\n/).filter(Boolean);
  const parts = [];
  paras.forEach((para, pi) => {
    const sents = para.match(/[^.!?]+[.!?]/g) || [para];
    sents.forEach((s, si) => {
      const isCrisis = crisis.test(s);
      if (omitCrisis && isCrisis) return;
      parts.push({
        text: s.trim() + (si < sents.length - 1 ? " " : ""),
        bold: (pi === 0 && si === 0) || (!omitCrisis && isCrisis),
        block: false,
      });
    });
    parts.push({ text: "", bold: false, block: true });
  });
  return parts;
}

// ---- Main component ----
export default function App() {
  const [consented, setConsented] = useState(false);
  const [chat, setChat] = useState([]);
  const [answers, setAnswers] = useState({});
  const [idx, setIdx] = useState(0);
  const [finished, setFinished] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  const [selectedOption, setSelectedOption] = useState(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat]);

  useEffect(() => {
    if (consented) {
      pushAssistant("I’ll ask 10 short questions about the past two weeks. Please choose one answer for each.");
      pushQuestion(0);
    }
  }, [consented]);

  function push(m) { setChat((c) => [...c, m]); }
  const pushAssistant = (text) => push({ role: "assistant", content: text });
  const pushAssistantParts = (parts) => push({ role: "assistant", parts });

  function pushQuestion(qIndex) {
    const d = DOMAINS[qIndex];
    if (!d) return;
    pushAssistant(`${qIndex + 1}. ${d.canonical}`);
  }

  async function handlePick(opt) {
    if (finished) return;
    const cur = DOMAINS[idx];
    const nextAnswers = { ...answers, [cur.id]: { label: opt.label, score: opt.score } };
    setAnswers(nextAnswers);
    setSelectedOption(opt.key);
    push({ role: "user", content: opt.label });

    if (idx < DOMAINS.length - 1) {
      setIdx(idx + 1);
      setSelectedOption(null);
      pushQuestion(idx + 1);
    } else {
      await finish(nextAnswers);
    }
  }

  function totalScore(ans) {
    const ids = ["interest","mood","sleep","energy","appetite","self_worth","concentration","psychomotor"];
    const base = ids.reduce((s, id) => s + (ans[id]?.score ?? 0), 0);
    const safety = Math.max(ans.si_dead?.score ?? 0, ans.si_harm?.score ?? 0);
    return { total: base + safety, safety, siDead: ans.si_dead?.score ?? 0, siHarm: ans.si_harm?.score ?? 0 };
  }

  async function finish(ans) {
    setFinished(true);
    const { total, safety, siDead, siHarm } = totalScore(ans);
    const band = severityFromTotal(total);

    const recap = [
      "Here’s your PHQ-9 summary:",
      "",
      ...DOMAINS.map(
        (d, i) => `${i + 1}. ${d.label}: ${ans[d.id]?.label ?? "Not answered"} (score ${ans[d.id]?.score ?? "-"})`
      ),
      `PHQ-9 Total (higher of safety items used): ${total} — ${band}`,
      `(Safety details) Better off dead: ${siDead}; Harming yourself: ${siHarm}; Combined: ${Math.max(siDead, siHarm)}`
    ].join("\n");

    pushAssistantParts(makeRecapParts(recap));

    try {
      setLoading(true);
      const recapNoSafety = recap.replace(/Safety[\s\S]*/gi, "");
      console.debug("[finish] recapNoSafety →", recapNoSafety);

      const llm = await callLLM([
        { role: "system", content: SYSTEM_SUMMARY_ONLY },
        { role: "user", content: recapNoSafety },
      ]);

      console.debug("[finish] LLM reply ←", llm);
      const guidanceParts = makeGuidanceParts(llm, { omitCrisis: safety > 0 });
      pushAssistantParts(guidanceParts);

    } catch (err) {
      console.error("[finish] LLM error:", err);
      pushAssistant("Thanks for completing this check-in. If symptoms persist or affect daily life, consider speaking with a clinician you trust.");
    } finally {
      setLoading(false);
    }

    if (safety > 0) {
      push({
        role: "assistant",
        box: true,
        parts: [
          { text: "If you’re not feeling safe, you deserve help right now—call or text " },
          { text: "988", bold: true },
          { text: " (U.S.). If danger is immediate, call " },
          { text: "911", bold: true },
          { text: "." },
        ],
      });
    }
  }

  const showOpts = consented && !finished;

  return (
    <div style={S.page}>
      <ConsentModal open={!consented} onAccept={() => setConsented(true)} />
      <div style={S.container}>
        <header style={S.header}>
          <h1 style={{ fontSize: 18 }}>PHQ-9 Companion <span style={S.badge}>Prototype</span></h1>
          <small>{finished ? "Summary" : `Item ${Math.min(idx + 1, DOMAINS.length)} / ${DOMAINS.length}`}</small>
        </header>

        <div style={S.card}>
          <div ref={scrollRef} style={S.scroll}>
            {chat.map((m, i) => {
              const base = { ...S.bubble, ...(m.role === "assistant" ? S.bubbleAssistant : S.bubbleUser) };
              const style = m.box ? { ...base, ...S.cautionBox } : base;
              if (m.parts) {
                return (
                  <div key={i} style={style}>
                    {m.parts.map((p, j) =>
                      p.block ? (
                        <div key={j}>{p.bold ? <strong>{p.text}</strong> : <span>{p.text}</span>}</div>
                      ) : p.bold ? (
                        <strong key={j}>{p.text}</strong>
                      ) : (
                        <span key={j}>{p.text}</span>
                      )
                    )}
                  </div>
                );
              }
              return <div key={i} style={style}>{m.content}</div>;
            })}
            {loading && <div style={{ fontSize: 12, color: "#cbd5e1" }}>Assistant is typing…</div>}
          </div>

          {showOpts && (
            <div style={S.optionsGrid}>
              {OPTIONS.map((o) => (
                <button
                  key={o.key}
                  style={{
                    ...S.optionBtn,
                    background: selectedOption === o.key ? "rgba(56,189,248,.3)" : "rgba(2,6,23,.4)",
                  }}
                  onClick={() => handlePick(o)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}

          <footer style={{ marginTop: 12, fontSize: 12, color: "#7dd3fc" }}>
            If you’re in the U.S. and thinking about death or self-harm, dial <strong>988</strong> or visit{" "}
            <a href="https://988lifeline.org/chat" style={{ color: "#7dd3fc" }} target="_blank" rel="noreferrer">
              988lifeline.org/chat
            </a>. If you are in immediate danger, call <strong>911</strong>.
          </footer>
        </div>
      </div>
    </div>
  );
}

// ---- Styles ----
const S = {
  page: {
    minHeight: "100vh",
    background: "#0b1220",
    color: "#e5e7eb",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "2rem 4vw",
  },
  container: { width: "100%", maxWidth: "1600px", margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", marginBottom: 16, alignItems: "center" },
  badge: { marginLeft: 8, fontSize: 12, padding: "2px 8px", border: "1px solid #334155", borderRadius: 8 },
  card: { padding: 16, border: "1px solid #1f2937", borderRadius: 12, background: "#0f172a" },
  scroll: { display: "flex", flexDirection: "column", gap: 8, maxHeight: "65vh", overflow: "auto", paddingRight: 4 },
  bubble: { maxWidth: "85%", padding: 12, border: "1px solid #334155", borderRadius: 12, whiteSpace: "pre-wrap" },
  bubbleUser: { marginLeft: "auto", background: "rgba(30,41,59,.7)" },
  bubbleAssistant: { background: "rgb(16 20 38)", border: "none" },
  cautionBox: { border: "1px solid #e5e7eb", background: "rgba(255,255,255,0.05)", padding: 12, borderRadius: 10 },
  optionsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 },
  optionBtn: {
    border: "1px solid #334155",
    background: "rgba(2,6,23,.4)",
    color: "#e5e7eb",
    padding: "10px 12px",
    borderRadius: 10,
    fontWeight: 600,
    cursor: "pointer",
  },
  modalBackdrop: { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.45)", backdropFilter: "blur(2px)", padding: 16 },
  modalCard: { maxWidth: 640, border: "1px solid #1f2937", borderRadius: 12, background: "#020617", padding: 16 },
  noticeBox: { fontSize: 14, border: "1px solid rgba(146,64,14,.4)", background: "rgba(120,53,15,.15)", borderRadius: 8, padding: 12, margin: "8px 0" },
  checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14 },
};
