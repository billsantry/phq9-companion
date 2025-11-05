import React, { useEffect, useRef, useState } from "react";

/** PHQ-9 Companion — Pre-diagnostic wellbeing companion (v8.3.3)
 * - Numbered canonical questions (1..10), split safety 9a/9b
 * - Likert buttons (no preselect)
 * - Recap rendered as a multi-line list
 * - If safety > 0: remove crisis line from LLM guidance; show it ONLY in a bordered caution box
 * - Bold first sentence + any 988/911 references
 * - Robust cleanup of stray "S." token artifacts from LLM output
 * - Safe rich text rendering (no dangerouslySetInnerHTML)
 * - Assistant bubbles background rgb(16 20 38), no border
 */

async function callLLM(messages, apiUrl = "/api/llm") {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
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

// --- PHQ-9 domains -----------------------------------------------------------
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

const SYSTEM_SUMMARY_ONLY = `
You are “PHQ-9 Companion,” a pre-diagnostic wellbeing companion.
Write 4–7 sentences covering: prominent symptoms, day-to-day impact, 3–5 low-risk self-care ideas for elevated items (≥2),
and when to consider talking to a clinician. If any safety item > 0, include exactly one sentence noting 988 (U.S.)
and 911 if immediate danger. No diagnosis.
`.trim();

// --- Cleanup helpers ----------------------------------------------------------
// Remove orphaned "S." artifacts without touching real abbreviations like "U.S."
function cleanModelText(t) {
  if (!t) return t;
  let out = String(t);

  // Remove a line or trailing token that is exactly "S." (or "S")
  out = out.replace(/(?:^|\n)\s*[sS]\.\s*$/gm, ""); // line that's just "S."
  out = out.replace(/(?:^|\n)\s*[sS]\s*$/gm, "");   // line that's just "S"
  out = out.replace(/\s+[sS]\.\s*$/g, "");          // trailing " S."
  out = out.replace(/\s+[sS]\s*$/g, "");            // trailing " S"

  // Remove "S." that appears right before a capitalized sentence start:
  // "...options. S. It would be wise..." -> "...options. It would be wise..."
  out = out.replace(/([.?!])\s+[sS]\.\s+(?=[A-Z])/g, "$1 ");

  // Collapse excess whitespace
  out = out.replace(/(\s){2,}/g, " ").trim();
  return out;
}

// Convert recap/guidance safely into renderable parts
function makeRecapParts(text) {
  // Each line becomes its own block for list-like layout
  const crisis = /(988|911|immediate danger)/i;
  return String(text)
    .split("\n")
    .map((t) => ({ text: t, bold: crisis.test(t), block: true }));
}

function makeGuidanceParts(t, { omitCrisis } = {}) {
  const crisis = /(988|911|immediate danger)/i;
  const sents = String(t).match(/[^.!?]+[.!?]/g) || [String(t)];
  const filtered = sents
    .map((s) => cleanModelText(s).trim())
    // drop orphan artifacts like "S." or "S"
    .filter((s) => s && !/^[sS]\.?$/.test(s))
    // optionally remove crisis sentences (handled by the caution box)
    .filter((s) => (omitCrisis ? !crisis.test(s) : true));

  return filtered.map((s, i) => ({
    text: s + (i < filtered.length - 1 ? " " : ""),
    bold: i === 0 || (!omitCrisis && crisis.test(s)),
    block: false,
  }));
}

// --- Main component ----------------------------------------------------------
export default function App() {
  const [consented, setConsented] = useState(false);
  const [chat, setChat] = useState([]);
  const [answers, setAnswers] = useState({});
  const [idx, setIdx] = useState(0);
  const [finished, setFinished] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat]);

  useEffect(() => {
    if (consented) {
      pushAssistant("I’ll ask 10 short questions about the past two weeks. Please choose one answer for each.");
      pushQuestion(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consented]);

  function push(m) { setChat((c) => [...c, m]); }
  const pushAssistant = (text) => push({ role: "assistant", content: text });
  const pushAssistantParts = (parts) => push({ role: "assistant", parts });

  function pushQuestion(qIndex) {
    const d = DOMAINS[qIndex];
    if (!d) return;
    const number = `${qIndex + 1}. `;
    pushAssistant(number + d.canonical);
  }

  async function handlePick(opt) {
    if (finished) return;
    const cur = DOMAINS[idx];
    const nextAnswers = { ...answers, [cur.id]: { label: opt.label, score: opt.score } };
    setAnswers(nextAnswers);
    push({ role: "user", content: opt.label });

    if (idx < DOMAINS.length - 1) {
      const nextIndex = idx + 1;
      setIdx(nextIndex);
      pushQuestion(nextIndex);
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

    // Recap text — add a blank line after the header for clarity
    const recap = [
      "Here’s your PHQ-9 summary:",
      "",
      ...DOMAINS.map(
        (d, i) => `${i + 1}. ${d.label}: ${ans[d.id]?.label ?? "Not answered"} (score ${ans[d.id]?.score ?? "-"})`
      ),
      `PHQ-9 Total (higher of safety items used): ${total} — ${band}`,
      `(Safety details) Better off dead: ${siDead}; Harming yourself: ${siHarm}; Combined: ${Math.max(siDead, siHarm)}`
    ].join("\n");

    // Render recap as block lines (list-like)
    pushAssistantParts(makeRecapParts(recap));

    // LLM guidance — if safety > 0, omit any crisis sentence (it will appear in the caution box only)
    try {
      setLoading(true);
      const msgs = [
        { role: "system", content: SYSTEM_SUMMARY_ONLY },
        { role: "user", content: recap },
        { role: "user", content: `PHQ-9 total: ${total} (${band}). Write the guidance.` },
      ];
      const llm = await callLLM(msgs);

      // Robust cleanup for orphan "S." artifacts
      const cleanLLM = cleanModelText(llm);

      const guidanceParts = makeGuidanceParts(cleanLLM, { omitCrisis: safety > 0 });
      pushAssistantParts(guidanceParts);
    } catch {
      pushAssistant("Thanks for completing this check-in. If symptoms persist or affect daily life, consider speaking with a clinician you trust.");
    } finally {
      setLoading(false);
    }

    // Cautionary box (only if safety > 0)
    if (safety > 0) {
      push({
        role: "assistant",
        box: true,
        parts: [
          { text: "Because you noted thoughts of self-harm, it’s important to reach out for support—if you ever feel unsafe or might act on these thoughts, call or text " },
          { text: "988", bold: true },
          { text: " in the U.S., or " },
          { text: "911", bold: true },
          { text: " if you are in immediate danger.", bold: true },
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
                // Blocks on separate rows; inline parts inline
                return (
                  <div key={i} style={style}>
                    {m.parts.map((p, j) =>
                      p.block ? (
                        <div key={j}>
                          {p.bold ? <strong>{p.text}</strong> : <span>{p.text}</span>}
                        </div>
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
                <button key={o.key} style={S.optionBtn} onClick={() => handlePick(o)} aria-label={o.label}>
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

// --- Styles ------------------------------------------------------------------
const S = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(to bottom,#020617,#0b1220,#020617)",
    color: "#e5e7eb",
    display: "flex",
    justifyContent: "center",
    padding: "24px 0",
  },
  container: {
    width: "95vw",           // stretch to nearly full width
    maxWidth: "1400px",      // allow wide layouts
    margin: "0 auto",
  },
  header: { display: "flex", justifyContent: "space-between", marginBottom: 16, alignItems: "center" },
  badge: { marginLeft: 8, fontSize: 12, padding: "2px 8px", border: "1px solid #334155", borderRadius: 8 },
  card: {
    padding: 24,
    border: "1px solid #1f2937",
    borderRadius: 12,
    background: "rgba(15,23,42,.7)",
    width: "100%",                // make the card expand fully
    boxSizing: "border-box",
  },
  scroll: { display: "flex", flexDirection: "column", gap: 8, maxHeight: "65vh", overflow: "auto", paddingRight: 4 },
  bubble: {
    maxWidth: "100%",             // was 85%
    padding: 16,
    border: "1px solid #334155",
    borderRadius: 12,
    whiteSpace: "pre-wrap",
  },
  bubbleUser: { marginLeft: "auto", background: "rgba(30,41,59,.7)" },
  bubbleAssistant: { background: "rgb(16 20 38)", border: "none" },
  cautionBox: {
    border: "1px solid #e5e7eb",
    background: "rgba(255,255,255,0.05)",
    color: "#e5e7eb",
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    fontSize: 14,
    whiteSpace: "pre-wrap",
  },
  optionsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 },
  optionBtn: {
    border: "1px solid #334155",
    background: "rgba(2,6,23,.4)",
    color: "#e5e7eb",
    padding: "10px 12px",
    borderRadius: 10,
    fontWeight: 600,
  },
  modalBackdrop: { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.45)", backdropFilter: "blur(2px)", padding: 16 },
  modalCard: { maxWidth: 640, border: "1px solid #1f2937", borderRadius: 12, background: "#020617", padding: 16 },
  noticeBox: { fontSize: 14, border: "1px solid rgba(146,64,14,.4)", background: "rgba(120,53,15,.15)", borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 8 },
  checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14 },
};
