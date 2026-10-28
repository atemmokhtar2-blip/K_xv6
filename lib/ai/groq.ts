export type JsonResult = Record<string, unknown>;

function extractJson(raw: string): JsonResult {
  const cleaned = raw.trim().replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/, "");
  try { return JSON.parse(cleaned) as JsonResult; } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)) as JsonResult; } catch { /* fall through */ }
    }
    return { content: cleaned };
  }
}

function parseKeys(primary: string | undefined, rotated: string | undefined): string[] {
  const raw = rotated?.trim() || primary?.trim() || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch { /* comma/newline separated values are also supported */ }
  return raw.split(/[\n,]+/).map((key) => key.trim()).filter(Boolean);
}

const cursors: Record<string, number> = { gemini: 0, groq: 0 };

function shouldRotate(status: number) {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

async function callGemini(apiKey: string, model: string, system: string, input: Record<string, unknown>): Promise<JsonResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
          responseMimeType: "application/json"
        }
      }),
      signal: AbortSignal.timeout(18000)
    }
  );
  const body = await response.json() as {
    error?: { message?: string; status?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  if (!response.ok) {
    throw Object.assign(new Error(`Gemini API ${response.status}: ${body.error?.message || "request failed"}`), { status: response.status });
  }
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error(`Gemini returned no text (finishReason=${body.candidates?.[0]?.finishReason || "unknown"})`);
  return extractJson(text);
}

async function callGroq(apiKey: string, model: string, system: string, input: Record<string, unknown>): Promise<JsonResult> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }]
    }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json() as { error?: { message?: string }; choices?: Array<{ message?: { content?: string | null } }> };
  if (!response.ok) throw Object.assign(new Error(`Groq API ${response.status}: ${body.error?.message || "request failed"}`), { status: response.status });
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned an empty completion");
  return extractJson(text);
}

/**
 * Provider routing: use Gemini when configured, rotate through its keys on
 * quota/auth/server failures, then fall back to the configured Groq key pool.
 * Existing agent imports remain compatible.
 */
export async function callGroqAgent(
  agentName: string,
  instructions: string,
  input: Record<string, unknown>
): Promise<JsonResult> {
  const geminiKeys = parseKeys(process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEYS);
  const groqKeys = parseKeys(process.env.GROQ_API_KEY, process.env.GROQ_API_KEYS);
  const system = `أنت وكيل متخصص اسمه "${agentName}" ضمن نظام داخلي لتحليل أفكار المشاريع. لا تتحدث مع العميل مباشرة. أخرج JSON صالحًا فقط، دون Markdown أو نص خارجه. لا تخترع معلومات غير مذكورة؛ ضع الافتراضات بوضوح.\n${instructions}`;
  const failures: string[] = [];

  for (const provider of [
    { name: "Gemini", keys: geminiKeys, model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite", cursorKey: "gemini", call: callGemini },
    { name: "Groq", keys: groqKeys, model: process.env.GROQ_MODEL || "llama-3.1-8b-instant", cursorKey: "groq", call: callGroq }
  ]) {
    if (!provider.keys.length) continue;
    const start = cursors[provider.cursorKey] % provider.keys.length;
    for (let attempt = 0; attempt < provider.keys.length; attempt += 1) {
      const index = (start + attempt) % provider.keys.length;
      try {
        const result = await provider.call(provider.keys[index], provider.model, system, input);
        cursors[provider.cursorKey] = (index + 1) % provider.keys.length;
        return result;
      } catch (error) {
        const status = Number((error as { status?: number })?.status || 0);
        const message = String(error);
        failures.push(message);
        if (status && !shouldRotate(status)) break;
      }
    }
  }
  throw new Error(failures.length ? failures.join(" | ") : "No AI provider key configured. Set GEMINI_API_KEY or GROQ_API_KEY(S).");
}
