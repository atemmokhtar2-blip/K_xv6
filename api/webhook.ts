import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@vercel/postgres";

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgChat = { id: number; type?: string };
type TgMessage = { message_id: number; chat: TgChat; from?: TgUser; text?: string };
type TgCallback = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };
type TgApiResult = { ok: boolean; description?: string; result?: { message_id?: number } };
type Session = { step: string; payload: Record<string, string> };

const HOME = [
  [{ text: "🛠 يمكنك طلب البوت من هنا", callback_data: "service:new" }],
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

async function deleteMessage(chatId: number, messageId: number) {
  return telegram("deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS client_sessions (
    chat_id BIGINT PRIMARY KEY,
    step TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE SEQUENCE IF NOT EXISTS client_request_number_seq START WITH 100 INCREMENT BY 1`;
  await sql`CREATE TABLE IF NOT EXISTS client_requests (
    id BIGSERIAL PRIMARY KEY,
    request_number BIGINT UNIQUE DEFAULT nextval('client_request_number_seq'),
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
  await sql`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS request_number BIGINT`;
  await sql`ALTER TABLE client_requests ALTER COLUMN request_number SET DEFAULT nextval('client_request_number_seq')`;
  await sql`UPDATE client_requests SET request_number = nextval('client_request_number_seq') WHERE request_number IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS client_requests_request_number_uidx ON client_requests(request_number)`;
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
      const recent = await sql`SELECT request_number, service, status, created_at FROM client_requests
        WHERE telegram_user_id = ${callback.from.id}
        ORDER BY created_at DESC LIMIT 10`;
      const history = recent.rows.length
        ? recent.rows.map((row) => `#${row.request_number} — ${escapeHtml(String(row.service))} — ${escapeHtml(String(row.status))} — ${new Date(String(row.created_at)).toLocaleDateString("ar-EG")}`).join("\n")
        : "لا توجد طلبات مسجلة على حساب تيليجرام ده حتى الآن.";
      return showScreen(chatId, "followup", { ...currentPayload, service },
        `📋 <b>سجل طلباتك</b>\n\n${history}\n\nاكتب رقم الطلب كاملًا كما ظهر لك لمراجعة تفاصيله. التحقق مرتبط بحساب تيليجرام الذي أنشأ الطلب.`,
        [[{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]], existingMessageId);
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

  if (data === "confirm:yes") {
    const session = await getSession(chatId);
    if (!session || session.step !== "confirm") return start(chatId, callback.from, existingMessageId);
    const p = session.payload;
    const userId = callback.from.id;
    const saved = await sql`INSERT INTO client_requests
      (chat_id, telegram_user_id, username, full_name, service, project_details, budget, timeline, contact, status)
      VALUES (${chatId}, ${userId}, ${p.username || null}, ${p.fullName || fullName(callback.from)},
      ${p.service}, ${p.details}, ${p.budget || null}, ${p.timeline || null}, ${String(chatId)}, 'new')
      RETURNING id, request_number`;
    const requestId = saved.rows[0].request_number;
    const doneText = `تم استلام طلبك بنجاح. رقم الطلب: <b>#${requestId}</b>\n\nهراجع تفاصيل طلبك وأتواصل معاك هنا على تيليجرام.`;
    const donePayload = { ...p, uiMessageId: String(existingMessageId || p.uiMessageId || "") };
    await showScreen(chatId, "done", donePayload, doneText,
      [[{ text: "القائمة الرئيسية", callback_data: "home" }]], existingMessageId);

    const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminId) {
      const adminText = `📥 <b>طلب مشروع جديد #${requestId}</b>
الخدمة: ${escapeHtml(p.service)}
الاسم: ${escapeHtml(p.fullName || fullName(callback.from))}
يوزر تيليجرام: ${p.username ? "@" + escapeHtml(p.username) : "غير متاح"}
معرّف تيليجرام: <code>${userId}</code>
التفاصيل: ${escapeHtml(p.details)}
الميزانية: ${escapeHtml(p.budget || "لم يحدد")}
المدة: ${escapeHtml(p.timeline || "لم يحدد")}`;
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
    const normalized = text.replace(/^#/, "").trim();
    if (!/^\d{1,18}$/.test(normalized)) {
      return showScreen(chatId, "followup", payload,
        "رقم الطلب غير صالح. اكتب الأرقام فقط كما ظهرت في رسالة تأكيد الطلب، أو اضغط إلغاء.",
        [[{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]]);
    }
    const found = await sql`SELECT request_number, service, project_details, budget, timeline, status, created_at
      FROM client_requests
      WHERE request_number = ${normalized} AND telegram_user_id = ${user?.id || 0} AND chat_id = ${chatId}
      LIMIT 1`;
    if (!found.rows.length) {
      return showScreen(chatId, "followup", payload,
        "لم يتم العثور على طلب بهذا الرقم مرتبط بحساب تيليجرام الحالي. راجع الرقم أو افتح سجل طلباتك من القائمة.",
        [[{ text: "إعادة عرض طلباتي", callback_data: "service:followup" }, { text: "إلغاء", callback_data: "cancel" }]]);
    }
    const item = found.rows[0];
    return showScreen(chatId, "done", payload,
      `📋 <b>تفاصيل الطلب #${item.request_number}</b>\nالحالة: ${escapeHtml(String(item.status))}\nالخدمة: ${escapeHtml(String(item.service))}\nالتفاصيل: ${escapeHtml(String(item.project_details))}\nالميزانية: ${escapeHtml(String(item.budget || "لم تحدد"))}\nالمدة: ${escapeHtml(String(item.timeline || "لم تحدد"))}\nتاريخ الطلب: ${new Date(String(item.created_at)).toLocaleDateString("ar-EG")}`,
      [[{ text: "القائمة الرئيسية", callback_data: "home" }]]);
  }

  if (session.step === "details") {
    payload.details = text;
    // Remove the previous bot prompt and send the budget question as a fresh
    // message so it appears directly below the customer's description.
    const previousMessageId = Number(payload.uiMessageId || 0);
    if (previousMessageId) {
      await deleteMessage(chatId, previousMessageId).catch(() => undefined);
    }
    const sent = await send(chatId,
      "وصل وصف فكرتك واتحفظ. ميزانيتك التقريبية للمشروع إيه؟ اكتب رقم أو نطاق، أو «مش محدد».",
      [[{ text: "مش محدد", callback_data: "budget:skip" }, { text: "إلغاء", callback_data: "cancel" }]]);
    const nextPayload = { ...payload, ...(sent.result?.message_id ? { uiMessageId: String(sent.result.message_id) } : {}) };
    await setSession(chatId, "budget", nextPayload);
    return;
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
