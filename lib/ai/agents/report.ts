import { callGroqAgent } from "../groq";

export async function createFinalReport(bundle: Record<string, unknown>, review: Record<string, unknown>) {
  const result = await callGroqAgent(
    "إعداد التقرير النهائي",
    "اكتب تقريرًا عربيًا مهنيًا واضحًا ومفيدًا لصاحب الفكرة. لا تخاطب العميل كمحادثة ولا تسأله أسئلة تفاعلية؛ أعد وثيقة تقرير. اذكر ملخص الفكرة، الهدف، الميزات الأساسية والإضافية، التصور التقني، متطلبات التشغيل، المخاطر، والأسئلة التي يجب حسمها قبل التسعير النهائي. لا تخترع أرقام أسعار أو مواعيد. اجعل التقرير نصًا عربيًا عاديًا داخل المفتاح report، وأضف status: ready وremaining_questions كمصفوفة. لا تستخدم HTML.",
    { bundle, review }
  );
  const report = typeof result.report === "string" ? result.report : "";
  if (!report.trim()) throw new Error("Groq report agent returned no report");
  return { report: report.slice(0, 9000), remainingQuestions: Array.isArray(result.remaining_questions) ? result.remaining_questions : [] };
}
