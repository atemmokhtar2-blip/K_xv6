import { sql } from "@vercel/postgres";
import { analyzeProjectOnce } from "./agents/fast-analysis";

type AgentOutput = Record<string, unknown>;

export async function runProjectAnalysis(
  analysisId: string,
  chatId: number,
  details: string,
  service: string
): Promise<void> {
  try {
    await sql`UPDATE project_analyses SET status = 'running', updated_at = NOW() WHERE id = ${analysisId}`;

    // One Groq completion replaces the previous 5-9 completion pipeline.
    const analysis = await analyzeProjectOnce(details, service);
    const bundle: AgentOutput = { service, details, ...analysis.result };
    const final = { report: analysis.report, remainingQuestions: analysis.remainingQuestions };
    const review = analysis.review;
    const quality = Number(review.score || 0);
    const status = (review.approved === true || quality >= 80) ? "completed" : "completed_with_warnings";

    await sql`UPDATE project_analyses
      SET status = ${status}, result = ${final.report}, review = ${JSON.stringify(review)}::jsonb,
          agent_outputs = ${JSON.stringify(bundle)}::jsonb, updated_at = NOW()
      WHERE id = ${analysisId}`;

    // Do not interrupt the client's intake form. If they already confirmed the request,
    // replace the current bot screen with the completed report.
    const sessions = await sql`SELECT step, payload FROM client_sessions WHERE chat_id = ${chatId}`;
    const session = sessions.rows[0] as { step?: string; payload?: Record<string, string> } | undefined;
    if (session?.step === "done" && session.payload?.analysisId === analysisId) {
      const messageId = Number(session.payload.uiMessageId || 0);
      if (messageId) {
        const reportText = formatClientReport(final.report, session.payload);
        await telegramEdit(chatId, messageId, reportText).catch((error) => console.error("Could not update report screen:", error));
      }
      const requestRows = await sql`SELECT id FROM client_requests WHERE chat_id = ${chatId} ORDER BY id DESC LIMIT 1`;
      const requestId = requestRows.rows[0]?.id;
      const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
      if (adminId) {
        await telegramSend(Number(adminId), `🧠 <b>اكتمل تحليل الطلب ${requestId ? "#" + requestId : ""}</b>\n${escapeHtml(final.report.slice(0, 3000))}`).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error("Project analysis failed:", error);
    await sql`UPDATE project_analyses SET status = 'failed', error_message = ${String(error).slice(0, 1000)}, updated_at = NOW() WHERE id = ${analysisId}`.catch(() => undefined);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] || ch));
}

function formatClientReport(report: string, payload: Record<string, string>) {
  const budget = payload.budget || "لم يحدد";
  const timeline = payload.timeline || "لم يحدد";
  return `🧠 <b>تحليل فكرة مشروعك اكتمل</b>\n\n<b>الخدمة:</b> ${escapeHtml(payload.service || "")}\n<b>الميزانية:</b> ${escapeHtml(budget)}\n<b>المدة:</b> ${escapeHtml(timeline)}\n\n${escapeHtml(report.slice(0, 2600))}`;
}

async function telegramEdit(chatId: number, messageId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || (!result.ok && !result.description?.toLowerCase().includes("message is not modified"))) {
    throw new Error(result.description || "Telegram edit failed");
  }
}

async function telegramSend(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!response.ok) throw new Error("Telegram send failed");
}
