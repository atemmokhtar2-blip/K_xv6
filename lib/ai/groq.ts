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

export async function callGroqAgent(
  agentName: string,
  instructions: string,
  input: Record<string, unknown>
): Promise<JsonResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 1800,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `أنت وكيل متخصص اسمه "${agentName}" ضمن نظام داخلي لتحليل أفكار المشاريع. لا تتحدث مع العميل مباشرة. أخرج JSON صالحًا فقط، دون Markdown أو نص خارجه. لا تخترع معلومات غير مذكورة؛ ضع الافتراضات بوضوح.
${instructions}`
        },
        { role: "user", content: JSON.stringify(input) }
      ]
    }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json() as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  if (!response.ok) {
    throw new Error(`Groq API ${response.status}: ${body.error?.message || "request failed"}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty completion");
  return extractJson(content);
}
