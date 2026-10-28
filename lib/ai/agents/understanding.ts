import { callGroqAgent } from "../groq";

export function understandIdea(details: string, service: string, revisionNote = "") {
  return callGroqAgent(
    "فهم الفكرة",
    "استخرج الهدف الحقيقي للمشروع، المشكلة التي يحلها، المستخدمين المستهدفين، النتيجة التي يتوقعها العميل، وما هو مؤكد مقابل ما هو مجرد افتراض. إذا كانت الفكرة غامضة فاذكر الغموض بدل اختراع تفاصيل. المفاتيح المطلوبة: project_summary, goals (array), target_users, confirmed_facts (array), assumptions (array), ambiguities (array), confidence (number 0-100).",
    { details, service, revisionNote }
  );
}
