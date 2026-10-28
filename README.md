# XELVOR Client Intake Bot

بوت تيليجرام خاص بمطوّر بوتات لاستقبال طلبات العملاء بطريقة منظمة. يعمل كـ Vercel Serverless Function ويستخدم PostgreSQL لحفظ خطوات المحادثة والطلبات.

## المميزات
- قائمة خدمات تفاعلية: بوت جديد، تطوير، إصلاح أخطاء، استشارة، متابعة طلب.
- نموذج ثابت متعدد الخطوات لجمع وصف المشروع والميزانية والمدة.
- مراجعة العميل للطلب قبل الإرسال.
- حفظ الطلبات في PostgreSQL مع رقم طلب وحالة.
- إشعار إداري داخل تيليجرام عند وصول طلب جديد.
- مسارات فحص صحة الخدمة: `/api/health`، وWebhook على `/api/webhook`.

## متغيرات البيئة
اضبطها في Vercel Project Settings → Environment Variables:

- `TELEGRAM_BOT_TOKEN`: توكن البوت من BotFather.
- `TELEGRAM_ADMIN_CHAT_ID`: رقم محادثة تيليجرام الخاصة بحساب الإدارة.
- `TELEGRAM_WEBHOOK_SECRET`: سلسلة عشوائية طويلة لحماية الـ webhook.
- `POSTGRES_URL`: رابط اتصال PostgreSQL متاح من Vercel.

لا تضع التوكن أو أسرار قاعدة البيانات في GitHub أو في الرسائل.

## إعداد قاعدة البيانات
يلزم توفير PostgreSQL وربط رابط الاتصال `POSTGRES_URL`. ينشئ التطبيق جدولَي `client_sessions` و`client_requests` تلقائيًا عند أول تحديث يصل إلى webhook.

## تفعيل البوت بعد النشر
بعد نشر المشروع وضبط المتغيرات، اضبط Webhook مرة واحدة عبر Telegram Bot API باستخدام رابط مشروعك:
`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR-VERCEL-DOMAIN>/api/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

نفّذ ذلك بأداة آمنة ولا تحفظ الرابط المحتوي على التوكن في المستودع أو السجلات.

## ملاحظة
النشر على Vercel لا يوفّر تلقائيًا قاعدة بيانات أو توكن تيليجرام. يجب إعداد المتغيرات وربط PostgreSQL قبل استقبال طلبات حقيقية.
