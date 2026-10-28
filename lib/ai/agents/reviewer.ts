import { callGroqAgent } from "../groq";

export function reviewAnalysis(bundle: Record<string, unknown>, round: number) {
  return callGroqAgent(
    "مراجع الجودة الناقد",
    "راجع مخرجات الوكلاء بصرامة. اكتشف التناقضات، النواقص، الافتراضات التي عُرضت كحقائق، الوعود غير المدعومة، والمتطلبات الأمنية المنسية. لا توافق لمجرد أن الصياغة جيدة. أعطِ درجة من 0 إلى 100. المفاتيح: approved (boolean), score (number), issues (array of strings), revision_instructions (array of strings), summary. approved تكون true فقط إذا كانت الدرجة 80 أو أكثر ولا توجد فجوة جوهرية.",
    { bundle, round }
  );
}
