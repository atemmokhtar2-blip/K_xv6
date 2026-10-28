import { sql } from "@vercel/postgres";
import { analyzeProjectOnce } from "./agents/fast-analysis";

type JsonObject = Record<string, any>;

async function checkpoint(analysisId: string, checkpoints: JsonObject, status = "running") {
  await sql`UPDATE project_analyses
    SET status = ${status}, agent_outputs = ${JSON.stringify({ checkpoints })}::jsonb, updated_at = NOW()
    WHERE id = ${analysisId}`;
}

export async function runProjectAnalysis(
  analysisId: string,
  chatId: number,
  details: string,
  service: string
): Promise<void> {
  try {
    await sql`UPDATE project_analyses SET status = 'running', error_message = NULL, updated_at = NOW() WHERE id = ${analysisId}`;

    // Keep the request economical: one structured model call for the full analysis.
    const analysis = await analyzeProjectOnce(details, service);
    const checkpoints: JsonObject = { unified: analysis.result };
    const review = analysis.review as JsonObject;
    const report = analysis.report.slice(0, 9000);
    if (!report.trim()) throw new Error("Final report is empty");
    const score = Number(review.score || 0);
    const status = review.approved === true || score >= 80 ? "completed" : "completed_with_warnings";

    await sql`UPDATE project_analyses
      SET status = ${status}, result = ${report}, review = ${JSON.stringify(review)}::jsonb,
          agent_outputs = ${JSON.stringify({ service, details, checkpoints })}::jsonb, updated_at = NOW()
      WHERE id = ${analysisId}`;

    const sessions = await sql`SELECT step, payload FROM client_sessions WHERE chat_id = ${chatId}`;
    const session = sessions.rows[0] as { step?: string; payload?: Record<string, string> } | undefined;
    if (session?.payload?.analysisId === analysisId && session.step === "analyzing") {
      const messageId = Number(session.payload.uiMessageId || 0);
      if (messageId) {
        await telegramEdit(chatId, messageId, formatClientReport(report, session.payload), [
          [{ text: "متابعة بيانات الطلب", callback_data: "analysis:continue" }],
          [{ text: "إعادة التحليل", callback_data: "analysis:try" }, { text: "القائمة الرئيسية", callback_data: "home" }]
        ]).catch((error) => console.error("Could not update analysis report screen:", error));
      }
      await sql`UPDATE client_sessions SET step = 'analysis_ready', updated_at = NOW()
        WHERE chat_id = ${chatId} AND payload->>'analysisId' = ${analysisId} AND step = 'analyzing'`;
    } else if (session?.step === "done" && session.payload?.analysisId === analysisId) {
      const messageId = Number(session.payload.uiMessageId || 0);
      if (messageId) await telegramEdit(chatId, messageId, formatClientReport(report, session.payload)).catch((error) => console.error("Could not update report screen:", error));
      const requestRows = await sql`SELECT id FROM client_requests WHERE chat_id = ${chatId} ORDER BY id DESC LIMIT 1`;
      const requestId = requestRows.rows[0]?.id;
      const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
      if (adminId) await telegramSend(Number(adminId), `🧠 <b>اكتمل تحليل الطلب ${requestId ? "#" + requestId : ""}</b>\n${escapeHtml(report.slice(0, 3000))}`).catch(() => undefined);
    }
  } catch (error) {
    console.error("Project analysis failed:", error);
    await sql`UPDATE project_analyses SET status = 'failed', error_message = ${String(error).slice(0, 1000)}, updated_at = NOW() WHERE id = ${analysisId}`.catch(() => undefined);
    const sessions = await sql`SELECT step, payload FROM client_sessions WHERE chat_id = ${chatId}`.catch(() => ({ rows: [] as Array<{ step?: string; payload?: Record<string, string> }> }));
    const session = sessions.rows[0] as { step?: string; payload?: Record<string, string> } | undefined;
    if (session?.step === "analyzing" && session.payload?.analysisId === analysisId) {
      const messageId = Number(session.payload.uiMessageId || 0);
      if (messageId) {
        await telegramEdit(chatId, messageId,
          "تعذّر إكمال التحليل هذه المرة. وصف فكرتك ما زال محفوظًا؛ اضغط إعادة المحاولة، أو ارجع للقائمة.",
          [[{ text: "إعادة المحاولة", callback_data: "analysis:try" }, { text: "القائمة الرئيسية", callback_data: "home" }]]
        ).catch((editError) => console.error("Could not show analysis failure:", editError));
      }
      await sql`UPDATE client_sessions SET step = 'details_ready', updated_at = NOW()
        WHERE chat_id = ${chatId} AND payload->>'analysisId' = ${analysisId} AND step = 'analyzing'`.catch(() => undefined);
    }
  }
}

function escapeHtml(value: string) { return value.replace(/[&<>\"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] || ch)); }
function formatClientReport(report: string, payload: Record<string, string>) {
  return `🧠 <b>تحليل فكرة مشروعك اكتمل</b>\n\n<b>الخدمة:</b> ${escapeHtml(payload.service || "")}\n<b>الميزانية:</b> ${escapeHtml(payload.budget || "لم يحدد")}\n<b>المدة:</b> ${escapeHtml(payload.timeline || "لم يحدد")}\n\n${escapeHtml(report.slice(0, 2600))}`;
}
async function telegramEdit(chatId: number, messageId: number, text: string, keyboard?: unknown) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}), disable_web_page_preview: true }) });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || (!result.ok && !result.description?.toLowerCase().includes("message is not modified"))) throw new Error(result.description || "Telegram edit failed");
}
async function telegramSend(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!response.ok) throw new Error("Telegram send failed");
}
