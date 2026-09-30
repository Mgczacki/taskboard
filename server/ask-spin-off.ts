export interface SpinOffExchange {
  sourceNum: number;
  question: string;
  answer: string;
}

export function spinOffPrompt(exchange: SpinOffExchange): string {
  const { sourceNum, question, answer } = exchange;
  if (!Number.isSafeInteger(sourceNum) || sourceNum < 1) throw new Error('A source task number is required.');
  if (typeof question !== 'string' || !question.trim()) throw new Error('A completed Ask question is required.');
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('A completed Ask answer is required.');
  return `Start a new task from this Ask exchange about task #${sourceNum}. Read task #${sourceNum}'s log if you need more context. Do not send a message to the source task.\n\nQuestion:\n${question.trim()}\n\nAnswer:\n${answer.trim()}`;
}
