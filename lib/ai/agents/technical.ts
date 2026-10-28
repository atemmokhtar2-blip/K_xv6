import { callGroqAgent } from "../groq";

export function designTechnicalPlan(details: string, understanding: Record<string, unknown>, requirements: Record<string, unknown>, revisionNote = "") {
  return callGroqAgent(
    "التخطيط التقني",
    "اقترح خطة تقنية أولية واقعية تناسب المشروع، مع تقسيم المكونات، تخزين البيانات، التكاملات الخارجية، النشر والتشغيل، الاختبارات، ومخاطر التنفيذ. لا تدّعِ أن أي تكامل أو خدمة تم اختبارها. لا تضع سعرًا نهائيًا أو موعدًا مضمونًا. ميّز بوضوح بين المقترح وما يحتاج تأكيدًا. المفاتيح: architecture, components (array), data_storage, integrations (array), deployment, testing_plan (array), risks (array), complexity (low|medium|high), estimate_notes.",
    { details, understanding, requirements, revisionNote }
  );
}
