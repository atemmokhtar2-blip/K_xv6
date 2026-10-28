import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@vercel/postgres";

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TgUser;
  text?: string;
};
type TgCallback = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };

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

async function telegram(method: string, body: Record<string, unknown>) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json() as { ok: boolean; description?: string };
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

async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS client_sessions (
    chat_id BIGINT PRIMARY KEY,
    step TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
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

async function getSession(chatId: number) {
  const result = await sql`SELECT step, payload FROM client_sessions WHERE chat_id = ${chatId}`;
  return result.rows[0] as { step: string; payload: Record<string, string> } | undefined;
}

async function setSession(chatId: number, step: string, payload: Record<string, string>) {
  await sql`INSERT INTO client_sessions (chat_id, step, payload, updated_at)
    VALUES (${chatId}, ${step}, ${JSON.stringify(payload)}::jsonb, NOW())
    ON CONFLICT (chat_id) DO UPDATE SET step = EXCLUDED.step,
      payload = EXCLUDED.payload, updated_at = NOW()`;
}

async function clearSession(chatId: number) {
  await sql`DELETE FROM client_sessions WHERE chat_id = ${chatId}`;
}

function fullName(user?: TgUser) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "عميل تيليجرام";
}

async function start(chatId: number, user?: TgUser) {
  await clearSession(chatId);
  await send(chatId,
    `أهلًا ${escapeHtml(user?.first_name || "بيك")}، نورتني.

أنا مساعد استقبال طلبات تطوير البوتات. اختار نوع الخدمة، وهجمع منك التفاصيل خطوة بخطوة عشان يوصلني طلبك بشكل منظم.

📌 التواصل وإرسال الطلبات هنا عبر تيليجرام فقط.`,
    HOME);
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return value.replace(/[&<>"]/g, (ch) => entities[ch] || ch);
}

async function handleCallback(callback: TgCallback) {
  const chatId = callback.message?.chat.id;
  if (!chatId) return;
  await telegram("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
  const data = callback.data || "";
  if (data === "home" || data === "cancel") return start(chatId, callback.from);
  if (data.startsWith("service:")) {
    const serviceKey = data.split(":")[1];
    const service = SERVICES[serviceKey];
    if (!service) return start(chatId, callback.from);
    if (serviceKey === "followup") {
      await setSession(chatId, "followup", { service });
      return send(chatId, "ابعت رقم الطلب لو معاك، أو اكتب اسم المستخدم اللي سجلت بيه الطلب.");
    }
    await setSession(chatId, "details", { service, username: callback.from.username || "", fullName: fullName(callback.from) });
    return send(chatId,
      `تمام، اخترت: <b>${escapeHtml(service)}</b>

اكتب وصف الفكرة أو المشكلة بالتفصيل. اذكر المميزات اللي محتاجها وأي روابط أو أمثلة مفيدة. لا ترسل كلمات مرور أو مفاتيح سرية.`,
      [[{ text: "إلغاء والعودة للقائمة", callback_data: "cancel" }]]);
  }
  if (data === "confirm:yes") {
    const session = await getSession(chatId);
    if (!session || session.step !== "confirm") return start(chatId, callback.from);
    const p = session.payload;
    const userId = callback.from.id;
    const saved = await sql`INSERT INTO client_requests
      (chat_id, telegram_user_id, username, full_name, service, project_details, budget, timeline, contact, status)
      VALUES (${chatId}, ${userId}, ${p.username || null}, ${p.fullName || fullName(callback.from)},
      ${p.service}, ${p.details}, ${p.budget || null}, ${p.timeline || null}, ${String(chatId)}, 'new')
      RETURNING id`;
    const requestId = saved.rows[0].id;
    await clearSession(chatId);
    await send(chatId, `تم استلام طلبك بنجاح.
رقم الطلب: <b>#${requestId}</b>

هراجع التفاصيل وأتواصل معاك هنا على تيليجرام. تقدر ترجع للقائمة الرئيسية من الزر التالي.`,
      [[{ text: "القائمة الرئيسية", callback_data: "home" }]]);
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
    if (!session) return start(chatId, callback.from);
    await setSession(chatId, "details", session.payload);
    return send(chatId, "اكتب وصف المشروع من جديد:");
  }
}

async function handleMessage(message: TgMessage) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const user = message.from;
  if (message.chat.type && message.chat.type !== "private") return;
  if (text === "/start" || text === "/menu") return start(chatId, user);
  if (text === "/cancel") return start(chatId, user);
  if (!text) return;
  const session = await getSession(chatId);
  if (!session) return send(chatId, "اختار الخدمة الأول من القائمة عشان أقدر أسجل طلبك بشكل صحيح.", HOME);
  const payload: Record<string, string> = { ...session.payload, username: user?.username || session.payload.username || "", fullName: fullName(user) };
  if (session.step === "followup") {
    const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminId) await send(Number(adminId), `🔎 استفسار متابعة من ${escapeHtml(fullName(user))} (${user?.username ? "@" + escapeHtml(user.username) : "بدون يوزر"})
الرسالة: ${escapeHtml(text)}`).catch(() => undefined);
    await clearSession(chatId);
    return send(chatId, "وصل طلب المتابعة. هراجعه وأرد عليك هنا على تيليجرام.", [[{ text: "القائمة الرئيسية", callback_data: "home" }]]);
  }
  if (session.step === "details") {
    payload.details = text;
    await setSession(chatId, "budget", payload);
    return send(chatId, "ميزانيتك التقريبية للمشروع إيه؟ تقدر تكتب رقم أو نطاق، أو اكتب «مش محدد».", [[{ text: "مش محدد", callback_data: "budget:skip" }, { text: "إلغاء", callback_data: "cancel" }]]);
  }
  if (session.step === "budget") {
    payload.budget = text;
    await setSession(chatId, "timeline", payload);
    return send(chatId, "محتاج المشروع خلال قد إيه؟ اكتب المدة التقريبية أو «مش محدد».", [[{ text: "مش محدد", callback_data: "timeline:skip" }, { text: "إلغاء", callback_data: "cancel" }]]);
  }
  if (session.step === "timeline") {
    payload.timeline = text;
    await setSession(chatId, "confirm", payload);
    return send(chatId,
      `راجع طلبك قبل الإرسال:

<b>الخدمة:</b> ${escapeHtml(payload.service)}
<b>التفاصيل:</b> ${escapeHtml(payload.details || "")}
<b>الميزانية:</b> ${escapeHtml(payload.budget || "لم يحدد")}
<b>المدة:</b> ${escapeHtml(payload.timeline)}

هل تؤكد إرسال الطلب؟`,
      [[{ text: "تأكيد وإرسال", callback_data: "confirm:yes" }, { text: "تعديل التفاصيل", callback_data: "confirm:edit" }], [{ text: "إلغاء", callback_data: "cancel" }]]);
  }
  return send(chatId, "كمل الخطوة الحالية، أو اكتب /menu للرجوع للقائمة.");
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
    if (update.callback_query) {
      const data = update.callback_query.data || "";
      if (data === "budget:skip" || data === "timeline:skip") {
        const chatId = update.callback_query.message?.chat.id;
        if (chatId) {
          const session = await getSession(chatId);
          if (session) {
            const payload: Record<string, string> = { ...session.payload, username: update.callback_query.from.username || session.payload.username || "", fullName: fullName(update.callback_query.from) };
            if (data === "budget:skip" && session.step === "budget") {
              payload.budget = "مش محدد";
              await setSession(chatId, "timeline", payload);
              await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => undefined);
              await send(chatId, "محتاج المشروع خلال قد إيه؟", [[{ text: "مش محدد", callback_data: "timeline:skip" }, { text: "إلغاء", callback_data: "cancel" }]]);
              return res.status(200).json({ ok: true });
            }
            if (data === "timeline:skip" && session.step === "timeline") {
              payload.timeline = "مش محدد";
              await setSession(chatId, "confirm", payload);
              await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => undefined);
              await send(chatId, `راجع طلبك قبل الإرسال:

<b>الخدمة:</b> ${escapeHtml(payload.service)}
<b>التفاصيل:</b> ${escapeHtml(payload.details || "")}
<b>الميزانية:</b> ${escapeHtml(payload.budget || "مش محدد")}
<b>المدة:</b> ${escapeHtml(payload.timeline)}

هل تؤكد إرسال الطلب؟`, [[{ text: "تأكيد وإرسال", callback_data: "confirm:yes" }, { text: "تعديل التفاصيل", callback_data: "confirm:edit" }], [{ text: "إلغاء", callback_data: "cancel" }]]);
              return res.status(200).json({ ok: true });
            }
          }
        }
      }
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return res.status(200).json({ ok: true });
  }
}
