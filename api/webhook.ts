import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@vercel/postgres";
import { waitUntil } from "@vercel/functions";
import { randomUUID } from "node:crypto";
import { runProjectAnalysis } from "../lib/ai/orchestrator";

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgChat = { id: number; type?: string };
type TgMessage = { message_id: number; chat: TgChat; from?: TgUser; text?: string };
type TgCallback = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };
type TgApiResult = { ok: boolean; description?: string; result?: { message_id?: number } };
type Session = { step: string; payload: Record<string, string> };
type AnalysisRow = { status: string; result?: string | null; error_message?: string | null };

const HOME = [
  [{ text: "🛠 طلب بوت جديد", callback_data: "service:new" }],
  [{ text: "⚙️ تطوير بوت موجود", callback_data: "service:upgrade" }],
  [{ text: "🧰 إصلاح أخطاء", callback_data: "service:fix" }],
  [{ text: "💡 استشارة أو فكرة مشروع", callback_data: "service:consult" }],
  [{ text: "📋 متابعة طلب سابق", callback_data: "service:followup" }]
];

const SERVICES: Record<string, string> = {
  new: "إنشاء بوت جديد",
  upgrade: "تطوير بوت موجود",
  fix: "إصلاح أخطاء",
  consult: "استشارة أو فكرة مشروع",
  followup: "متابعة طلب سابق"
};

async function telegram(method: string, body: Record<string, unknown>): Promise<TgApiResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json() as TgApiResult;
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result;
}

async function send(chatId: number, text: string, keyboard?: unknown) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    disable_web_page_preview: true
  });
}

async function edit(chatId: number, messageId: number, text: string, keyboard?: unknown) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    disable_web_page_preview: true
  });
}

async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS client_sessions (
    chat_id BIGINT PRIMARY KEY,
    step TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS project_analyses (
    id TEXT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    service TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT,
    review JSONB,
    agent_outputs JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS project_analyses_chat_id_idx ON project_analyses (chat_id, created_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS client_requests (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    telegram_user_id BIGINT NOT NULL,
    username TEXT,
    full_name TEXT NOT NULL,
    service TEXT NOT NULL,
    project_details TEXT NOT NULL,
    budget TEXT,
    timeline TEXT,
    contact TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

async function getSession(chatId: number): Promise<Session | undefined> {
  const result = await sql`SELECT step, payload FROM client_sessions WHERE chat_id = ${chatId}`;
  return result.rows[0] as Session | undefined;
}

async function setSession(chatId: number, step: string, payload: Record<string, string>) {
  await sql`INSERT INTO client_sessions (chat_id, step, payload, updated_at)
    VALUES (${chatId}, ${step}, ${JSON.stringify(payload)}::jsonb, NOW())
    ON CONFLICT (chat_id) DO UPDATE SET step = EXCLUDED.step,
      payload = EXCLUDED.payload, updated_at = NOW()`;
}

function fullName(user?: TgUser) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "عميل تيليجرام";
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return value.replace(/[&<>"]/g, (ch) => entities[ch] || ch);
}

/**
 * Keep one persistent bot message per private chat. Each flow step edits that
 * message; only send a new one if the previous message cannot be edited.
 */
async function showScreen(
  chatId: number,
  step: string,
  payload: Record<string, string>,
  text: string,
  keyboard?: unknown,
  preferredMessageId?: number
) {
  let messageId = Number(payload.uiMessageId || preferredMessageId || 0);
  if (messageId) {
    try {
      await edit(chatId, messageId, text, keyboard);
    } catch (error) {
      const reason = String(error);
      // Telegram reports this when the requested text/keyboard already matches.
      if (!reason.toLowerCase().includes("message is not modified")) {
        const sent = await send(chatId, text, keyboard);
        messageId = Number(sent.result?.message_id || 0);
      }
    }
  } else {
    const sent = await send(chatId, text, keyboard);
    messageId = Number(sent.result?.message_id || 0);
  }
  const nextPayload = { ...payload, ...(messageId ? { uiMessageId: String(messageId) } : {}) };
  await setSession(chatId, step, nextPayload);
}

async function start(chatId: number, user?: TgUser, preferredMessageId?: number) {
  const oldSession = await getSession(chatId);
  const payload = {
    username: user?.username || oldSession?.payload.username || "",
    fullName: fullName(user)
  };
  await showScreen(
    chatId,
    "home",
    payload,
    `أهلًا ${escapeHtml(user?.first_name || "بيك")}، نورتني.

أنا مساعد استقبال طلبات تطوير البوتات. اختار نوع الخدمة، وهجمع منك التفاصيل خطوة بخطوة عشان يوصلني طلبك بشكل منظم.

📌 التواصل وإرسال الطلبات هنا عبر تيليجرام فقط.`,
    HOME,
    preferredMessageId
  );
}

async function answerCallback(callback: TgCallback) {
  await telegram("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
}

async function handleCallback(callback: TgCallback) {
  const chatId = callback.message?.chat.id;
  if (!chatId) return;
  await answerCallback(callback);
  const data = callback.data || "";
  const existingMessageId = callback.message?.message_id;
  const current = await getSession(chatId);
  const currentPayload = {
    ...(current?.payload || {}),
    username: callback.from.username || current?.payload.username || "",
    fullName: fullName(callback.from),
    ...(existingMessageId ? { uiMessageId: String(existingMessageId) } : {})
  };

  if (data === "home" || data === "cancel") return start(chatId, callback.from, existingMessageId);

  if (data.startsWith("service:")) {
    const serviceKey = data.split(":")[1];
    const service = SERVICES[serviceKey];
    if (!service) return start(chatId, callback.from, existingMessageId);
    if (serviceKey === "followup") {
      return showScreen(chatId, "followup", { ...currentPayload, service }, "ابعت رقم الطلب لو معاك، أو اكتب اسم المستخدم اللي سجلت بيه الطلب.", [
        [{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]
      ], existingMessageId);
    }
    return showScreen(
      chatId,
      "details",
      { ...currentPayload, service },
      `تمام، اخترت: <b>${escapeHtml(service)}</b>

اكتب وصف الفكرة أو المشكلة بالتفصيل. اذكر المميزات اللي محتاجها وأي روابط أو أمثلة مفيدة. لا ترسل كلمات مرور أو مفاتيح سرية.`,
      [[{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]],
      existingMessageId
    );
  }

  if (data === "budget:skip" && current?.step === "budget") {
    return showScreen(chatId, "timeline", { ...currentPayload, ...current.payload, budget: "مش محدد" },
      "محتاج المشروع خلال قد إيه؟ اكتب المدة التقريبية أو «مش محدد».",
      [[{ text: "مش محدد", callback_data: "timeline:skip" }, { text: "إلغاء", callback_data: "cancel" }]],
      existingMessageId);
  }

  if (data === "timeline:skip" && current?.step === "timeline") {
    const payload = { ...currentPayload, ...current.payload, timeline: "مش محدد" };
    return showScreen(chatId, "confirm", payload, confirmationText(payload), confirmationKeyboard(), existingMessageId);
  }

  if (data === "analysis:try") {
    const session = await getSession(chatId);
    if (!session || !["details_ready", "analysis_ready"].includes(session.step) || !session.payload.details) {
      return start(chatId, callback.from, existingMessageId);
    }
    const analysisId = randomUUID();
    const payload: Record<string, string> = { ...session.payload, analysisId, uiMessageId: String(existingMessageId || session.payload.uiMessageId || "") };
    const aiConfigured = Boolean(process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS);
    await sql`INSERT INTO project_analyses (id, chat_id, service, details, status, error_message)
      VALUES (${analysisId}, ${chatId}, ${payload.service || "مش محدد"}, ${payload.details},
      ${aiConfigured ? "queued" : "failed"}, ${aiConfigured ? null : "GROQ_API_KEY(S) is not configured"})`;
    if (!aiConfigured) {
      return showScreen(chatId, "details_ready", payload,
        "تعذّر تشغيل التحليل لأن مفاتيح الذكاء الاصطناعي غير مضبوطة حاليًا. وصفك محفوظ؛ جرّب مرة أخرى لاحقًا.",
        [[{ text: "إعادة المحاولة", callback_data: "analysis:try" }, { text: "إلغاء", callback_data: "cancel" }]],
        existingMessageId);
    }
    await showScreen(chatId, "analyzing", payload,
      "🧠 <b>جاري تحليل فكرتك الآن</b>\n\nهراجع الهدف والمتطلبات والتصور التقني والمخاطر. هتظهر النتيجة هنا في نفس الرسالة.",
      undefined,
      existingMessageId);
    waitUntil(runProjectAnalysis(analysisId, chatId, payload.details, payload.service || "مش محدد"));
    return;
  }

  if (data === "analysis:edit") {
    const session = await getSession(chatId);
    if (!session) return start(chatId, callback.from, existingMessageId);
    return showScreen(chatId, "details", session.payload, "اكتب وصف الفكرة من جديد:", [
      [{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]
    ], existingMessageId);
  }

  if (data === "analysis:continue") {
    const session = await getSession(chatId);
    if (!session || session.step !== "analysis_ready") return start(chatId, callback.from, existingMessageId);
    const payload = { ...session.payload, username: callback.from.username || session.payload.username || "", fullName: fullName(callback.from) };
    return showScreen(chatId, "budget", payload,
      "تمام، لو حابب كمل بيانات الطلب. ميزانيتك التقريبية للمشروع إيه؟ اكتب رقم أو نطاق، أو «مش محدد».",
      [[{ text: "مش محدد", callback_data: "budget:skip" }, { text: "إلغاء", callback_data: "cancel" }]],
      existingMessageId);
  }

  if (data === "confirm:yes") {
    const session = await getSession(chatId);
    if (!session || session.step !== "confirm") return start(chatId, callback.from, existingMessageId);
    const p = session.payload;
    const userId = callback.from.id;
    const saved = await sql`INSERT INTO client_requests
      (chat_id, telegram_user_id, username, full_name, service, project_details, budget, timeline, contact, status)
      VALUES (${chatId}, ${userId}, ${p.username || null}, ${p.fullName || fullName(callback.from)},
      ${p.service}, ${p.details}, ${p.budget || null}, ${p.timeline || null}, ${String(chatId)}, 'new')
      RETURNING id`;
    const requestId = saved.rows[0].id;
    const analysisId = p.analysisId || "";
    let analysis: AnalysisRow | undefined;
    if (analysisId) {
      const analysisResult = await sql`SELECT status, result, error_message FROM project_analyses WHERE id = ${analysisId} AND chat_id = ${chatId}`;
      analysis = analysisResult.rows[0] as AnalysisRow | undefined;
    }
    const report = analysis?.result?.trim();
    const doneText = report && (analysis?.status === "completed" || analysis?.status === "completed_with_warnings")
      ? `🧠 <b>تحليل فكرة مشروعك اكتمل</b>\nرقم الطلب: <b>#${requestId}</b>\n\n<b>الخدمة:</b> ${escapeHtml(p.service)}\n<b>الميزانية:</b> ${escapeHtml(p.budget || "لم يحدد")}\n<b>المدة:</b> ${escapeHtml(p.timeline || "لم يحدد")}\n\n${escapeHtml(report.slice(0, 2600))}`
      : analysis?.status === "failed"
        ? `تم استلام طلبك بنجاح. رقم الطلب: <b>#${requestId}</b>\n\nتعذّر إكمال التحليل الآلي حاليًا، وطلبك محفوظ للمراجعة. هتواصل معاك هنا على تيليجرام.`
        : `تم استلام طلبك بنجاح. رقم الطلب: <b>#${requestId}</b>\n\nتحليل فكرتك شغال حاليًا. هحدّث نفس الرسالة بالتقرير النهائي أول ما يكتمل، من غير ما تحتاج تبعت حاجة تانية.`;
    const donePayload = { ...p, uiMessageId: String(existingMessageId || p.uiMessageId || "") };
    await showScreen(chatId, "done", donePayload, doneText,
      [[{ text: "القائمة الرئيسية", callback_data: "home" }]], existingMessageId);

    const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminId) {
      const analysisText = report && (analysis?.status === "completed" || analysis?.status === "completed_with_warnings")
        ? `\n\n<b>تقرير الذكاء الاصطناعي:</b>\n${escapeHtml(report.slice(0, 2500))}`
        : `\n\nحالة التحليل: ${escapeHtml(analysis?.status || "لم يتم إنشاء تحليل")}`;
      const adminText = `📥 <b>طلب مشروع جديد #${requestId}</b>
الخدمة: ${escapeHtml(p.service)}
الاسم: ${escapeHtml(p.fullName || fullName(callback.from))}
يوزر تيليجرام: ${p.username ? "@" + escapeHtml(p.username) : "غير متاح"}
معرّف تيليجرام: <code>${userId}</code>
التفاصيل: ${escapeHtml(p.details)}
الميزانية: ${escapeHtml(p.budget || "لم يحدد")}
المدة: ${escapeHtml(p.timeline || "لم يحدد")}${analysisText}`;
      await send(Number(adminId), adminText, [[{ text: "فتح محادثة العميل", url: `tg://user?id=${userId}` }]]).catch(() => undefined);
    }
    return;
  }

  if (data === "confirm:edit") {
    const session = await getSession(chatId);
    if (!session) return start(chatId, callback.from, existingMessageId);
    return showScreen(chatId, "details", session.payload, "اكتب وصف المشروع من جديد:", [
      [{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]
    ], existingMessageId);
  }
}

function confirmationText(payload: Record<string, string>) {
  return `راجع طلبك قبل الإرسال:

<b>الخدمة:</b> ${escapeHtml(payload.service || "")}
<b>التفاصيل:</b> ${escapeHtml(payload.details || "")}
<b>الميزانية:</b> ${escapeHtml(payload.budget || "لم يحدد")}
<b>المدة:</b> ${escapeHtml(payload.timeline || "لم يحدد")}

هل تؤكد إرسال الطلب؟`;
}

function confirmationKeyboard() {
  return [
    [{ text: "تأكيد وإرسال", callback_data: "confirm:yes" }, { text: "تعديل التفاصيل", callback_data: "confirm:edit" }],
    [{ text: "إلغاء", callback_data: "cancel" }]
  ];
}

async function handleMessage(message: TgMessage) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const user = message.from;
  if (message.chat.type && message.chat.type !== "private") return;
  if (text === "/start" || text === "/menu" || text === "/cancel") return start(chatId, user);
  if (!text) return;
  const session = await getSession(chatId);
  if (!session) return start(chatId, user);

  const payload: Record<string, string> = {
    ...session.payload,
    username: user?.username || session.payload.username || "",
    fullName: fullName(user)
  };

  if (session.step === "followup") {
    const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminId) {
      await send(Number(adminId), `🔎 استفسار متابعة من ${escapeHtml(fullName(user))} (${user?.username ? "@" + escapeHtml(user.username) : "بدون يوزر"})
الرسالة: ${escapeHtml(text)}`).catch(() => undefined);
    }
    return showScreen(chatId, "done", payload,
      "وصل طلب المتابعة. هراجعه وأرد عليك هنا على تيليجرام.",
      [[{ text: "القائمة الرئيسية", callback_data: "home" }]]);
  }

  if (session.step === "details") {
    payload.details = text;
    return showScreen(chatId, "details_ready", payload,
      "وصل وصف فكرتك. اضغط <b>«جرّب التحليل»</b> عشان الذكاء الاصطناعي يحلل الفكرة ويعرض لك النتيجة هنا.",
      [[{ text: "🧠 جرّب التحليل", callback_data: "analysis:try" }],
       [{ text: "تعديل الوصف", callback_data: "analysis:edit" }, { text: "إلغاء", callback_data: "cancel" }]]);
  }

  if (session.step === "details_ready" && text) {
    payload.details = text;
    return showScreen(chatId, "details_ready", payload,
      "تم تحديث وصف الفكرة. اضغط <b>«جرّب التحليل»</b> لعرض تحليل الذكاء الاصطناعي.",
      [[{ text: "🧠 جرّب التحليل", callback_data: "analysis:try" }],
       [{ text: "إلغاء", callback_data: "cancel" }]]);
  }

  if (session.step === "budget") {
    payload.budget = text;
    return showScreen(chatId, "timeline", payload,
      "محتاج المشروع خلال قد إيه؟ اكتب المدة التقريبية أو «مش محدد».",
      [[{ text: "مش محدد", callback_data: "timeline:skip" }, { text: "إلغاء", callback_data: "cancel" }]]);
  }

  if (session.step === "timeline") {
    payload.timeline = text;
    return showScreen(chatId, "confirm", payload, confirmationText(payload), confirmationKeyboard());
  }

  return send(chatId, "استخدم الأزرار الموجودة في رسالة البوت، أو اكتب /menu لعرض القائمة.");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, service: "telegram-webhook" });
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret && req.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
    return res.status(401).json({ ok: false });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.POSTGRES_URL) {
    return res.status(503).json({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN or POSTGRES_URL environment variable" });
  }
  try {
    await ensureSchema();
    const update = req.body as TgUpdate;
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return res.status(200).json({ ok: true });
  }
}
