export const LONGMEMEVAL_ANSWER_PROMPT =
  'Answer the question using only the provided LongMemEval conversation history. If the answer is unsupported, say "No information available".';

export const buildAnswerPrompt = (input: {
  readonly context: string;
  readonly question: string;
}): string => {
  return `${LONGMEMEVAL_ANSWER_PROMPT}\n\nContext:\n${input.context}\n\nQuestion: ${input.question}\nAnswer:`;
};
