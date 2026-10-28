import { callGroqAgent } from "../groq";

export function analyzeRequirements(details: string, understanding: Record<string, unknown>, revisionNote = "") {
  return callGroqAgent(
    "تحليل المتطلبات",
    "حوّل الفكرة إلى متطلبات قابلة للفهم والتنفيذ. افصل الميزات الأساسية عن الإضافية، وحدد المدخلات والمخرجات، الأدوار والصلاحيات، حالات الاستخدام، حالات الخطأ، ومتطلبات الأمان والخصوصية. لا تعتبر أي ميزة مؤكدة إذا لم يطلبها العميل. المفاتيح: core_features (array), optional_features (array), user_flows (array), data_requirements (array), security_requirements (array), open_questions (array), dependencies (array).",
    { details, understanding, revisionNote }
  );
}
