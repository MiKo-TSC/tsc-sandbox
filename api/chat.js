const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;
const requestCounts = new Map();

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (ip || "unknown").trim().slice(0, 80);
}

function allowRequest(key) {
  const now = Date.now();
  const current = requestCounts.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestCounts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Bitte sende eine Chatnachricht per POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Der Chatbot ist noch nicht eingerichtet." });
  }

  if (!allowRequest(getClientKey(req))) {
    return res.status(429).json({ error: "Kurz durchatmen — bitte versuch es in einer Minute nochmal." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-8) : [];
  const input = messages
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 1200) }))
    .filter((item) => item.content.length > 0);

  if (!input.length || input[input.length - 1].role !== "user") {
    return res.status(400).json({ error: "Schreib zuerst eine kurze Nachricht." });
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        instructions: "Du bist ein freundlicher Partyplanungs-Buddy. Hilf auf Deutsch mit konkreten, unkomplizierten Ideen zu Gästeliste, Ablauf, Musik, Deko, Snacks und Budget. Stelle bei Bedarf eine kurze Rückfrage. Erfinde keine Angaben zu Ort, Datum oder Gästen. Bleib beim Thema Partyplanung und gib keine riskanten Ratschläge.",
        input,
        max_output_tokens: 350,
        store: false
      })
    });

    if (!upstream.ok) {
      const problem = await upstream.json().catch(() => ({}));
      console.error("OpenAI request failed", upstream.status, problem?.error?.code || "unknown_error");
      return res.status(502).json({ error: "Die KI-Antwort ist gerade fehlgeschlagen. Versuch es bitte nochmal." });
    }

    const result = await upstream.json();
    const reply = typeof result.output_text === "string" ? result.output_text.trim() : "";
    if (!reply) return res.status(502).json({ error: "Ich habe gerade keine Antwort erhalten. Versuch es bitte nochmal." });
    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Chat endpoint error", error?.name || "Error");
    return res.status(502).json({ error: "Verbindung zur KI gerade nicht möglich. Versuch es bitte gleich nochmal." });
  }
};

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
