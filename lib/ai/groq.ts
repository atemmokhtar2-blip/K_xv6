export type JsonResult = Record<string, unknown>;

function extractJson(raw: string): JsonResult {
  const cleaned = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "");
  try {
    return JSON.parse(cleaned) as JsonResult;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)) as JsonResult; } catch { /* handled below */ }
    }
    return { content: cleaned };
  }
}

function configuredKeys(): string[] {
  const rotated = process.env.GROQ_API_KEYS || "";
  const keys = rotated
    ? (() => {
        try {
          const parsed = JSON.parse(rotated);
          return Array.isArray(parsed) ? parsed : rotated.split(/[\n,]+/);
        } catch {
          return rotated.split(/[\n,]+/);
        }
      })()
    : [process.env.GROQ_API_KEY || ""];
  return keys.map((key) => String(key).trim()).filter(Boolean);
}

let keyCursor = 0;

function isRotatable(status: number) {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export async function callGroqAgent(
  agentName: string,
  instructions: string,
  input: Record<string, unknown>
): Promise<JsonResult> {
  const keys = configuredKeys();
  if (!keys.length) throw new Error("GROQ_API_KEYS or GROQ_API_KEY is not configured");
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const start = keyCursor % keys.length;
  let lastError = "Groq request failed";

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const index = (start + attempt) % keys.length;
    const apiKey = keys[index];
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_completion_tokens: 1000,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `أنت وكيل متخصص اسمه "${agentName}" ضمن نظام داخلي لتحليل أفكار المشاريع. لا تتحدث مع العميل مباشرة. أخرج JSON صالحًا فقط، دون Markdown أو نص خارجه. لا تخترع معلومات غير مذكورة؛ ضع الافتراضات بوضوح.\n${instructions}`
            },
            { role: "user", content: JSON.stringify(input) }
          ]
        }),
        signal: AbortSignal.timeout(12000)
      });
      const body = await response.json() as { error?: { message?: string }; choices?: Array<{ message?: { content?: string | null } }> };
      if (!response.ok) {
        lastError = `Groq API ${response.status}: ${body.error?.message || "request failed"}`;
        if (isRotatable(response.status)) continue;
        throw new Error(lastError);
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq returned an empty completion");
      keyCursor = (index + 1) % keys.length;
      return extractJson(content);
    } catch (error) {
      lastError = String(error);
      if (attempt + 1 >= keys.length) break;
    }
  }
  throw new Error(`${lastError}; all configured Groq keys were exhausted`);
}
