import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(200).json({
    ok: true,
    service: "XELVOR Client Intake Bot",
    mode: "telegram-webhook",
    configured: {
      telegramToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      adminChatId: Boolean(process.env.TELEGRAM_ADMIN_CHAT_ID),
      database: Boolean(process.env.POSTGRES_URL),
      webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      groqApiKey: Boolean(process.env.GROQ_API_KEY),
      groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-20b"
    }
  });
}
