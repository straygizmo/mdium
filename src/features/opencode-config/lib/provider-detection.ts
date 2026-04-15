/**
 * Detects Azure OpenAI content-filter refusal responses.
 * Requires both an apology marker and a refusal phrase, with a length
 * guard to avoid matching long legitimate responses that happen to
 * contain these phrases in passing.
 */
export function isAzureRefusal(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim().replace(/\u2019/g, "'");
  if (normalized.length > 300) return false;
  const hasSorry =
    normalized.includes("i'm sorry") || normalized.includes("i am sorry");
  const hasRefusal =
    normalized.includes("cannot assist") ||
    normalized.includes("can't assist") ||
    normalized.includes("cannot help") ||
    normalized.includes("can't help");
  return hasSorry && hasRefusal;
}
