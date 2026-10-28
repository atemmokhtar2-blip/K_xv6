import { callGroqAgent } from "../groq";

/**
 * One-pass project analysis. Combines the former understanding, requirements,
 * technical, review, and report calls into a single completion to reduce token
 * usage and latency. The result remains structured for PostgreSQL persistence.
 */
export async function analyzeProjectOnce(details: string, service: string) {
  const result = await callGroqAgent(
    "محلل ومهندس تخطيط المشاريع",
    [
      "حلل فكرة المشروع من البداية للنهاية في استجابة واحدة.",
      "كن دقيقًا: افصل الحقائق التي ذكرها العميل عن الافتراضات، ولا تخترع تفاصيل أو وعودًا.",
      "اجمع فهم الفكرة والمتطلبات والتخطيط التقني ومراجعة الجودة والتقرير النهائي في نفس النتيجة.",
      "اجعل التقرير عربيًا واضحًا ومفيدًا ومختصرًا نسبيًا. لا تحدد سعرًا نهائيًا أو موعدًا مضمونًا.",
      "نفّذ مراجعة ذاتية قبل الإخراج: ابحث عن التناقضات، المخاطر، الثغرات الأمنية، والنقاط الناقصة.",
      "أخرج JSON صالحًا فقط بالمفاتيح التالية:",
      "project_summary (string), goals (array), target_users (string), confirmed_facts (array), assumptions (array), ambiguities (array), confidence (number 0-100),",
      "core_features (array), optional_features (array), user_flows (array), data_requirements (array), security_requirements (array), open_questions (array), dependencies (array),",
      "architecture (string), components (array), data_storage (string), integrations (array), deployment (string), testing_plan (array), risks (array), complexity (low|medium|high), estimate_notes (string),",
      "review_score (number 0-100), review_issues (array), approved (boolean), report (string), remaining_questions (array).",
      "اجعل report تقريرًا متكاملًا بعناوين عربية بسيطة. لا تكرر كل البيانات حرفيًا ولا تستخدم HTML أو Markdown المعقد."
    ].join("\n"),
    { service, details }
  );

  const report = typeof result.report === "string" ? result.report.trim() : "";
  if (!report) {
    throw new Error("Groq one-pass analysis did not return a report");
  }

  const score = Number(result.review_score ?? result.confidence ?? 70);
  return {
    result,
    report: report.slice(0, 9000),
    review: {
      approved: result.approved === true || score >= 85,
      score: Math.max(0, Math.min(100, score)),
      issues: Array.isArray(result.review_issues) ? result.review_issues : [],
      summary: "مراجعة ذاتية ضمن استدعاء التحليل الموحد"
    },
    remainingQuestions: Array.isArray(result.remaining_questions) ? result.remaining_questions : []
  };
}
