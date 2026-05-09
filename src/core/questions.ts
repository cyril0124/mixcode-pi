import type { QuestionInfo, QuestionRequestState } from "./types.js";

export function createQuestionRequest(
  requestId: string,
  sessionId: string,
  questions: QuestionInfo[],
  options: Pick<QuestionRequestState, "extensionResolverId" | "extensionUiKind"> = {},
): QuestionRequestState {
  return {
    requestId,
    sessionId,
    questions,
    extensionResolverId: options.extensionResolverId,
    extensionUiKind: options.extensionUiKind,
    currentQuestionIndex: 0,
    highlightedOptionIndices: questions.map(() => 0),
    selectedAnswers: questions.map(() => []),
    customAnswers: questions.map(() => ""),
    dirty: false,
  };
}

export function answerCurrentQuestion(
  state: QuestionRequestState,
  answers: string[],
  customAnswer = "",
): void {
  const index = state.currentQuestionIndex;
  if (!state.questions[index]) throw new Error(`Question index out of range: ${index}`);
  state.selectedAnswers[index] = answers;
  state.customAnswers[index] = customAnswer;
  state.dirty = true;
}

export function moveQuestion(state: QuestionRequestState, delta: number): void {
  const next = state.currentQuestionIndex + delta;
  if (next < 0 || next >= state.questions.length)
    throw new Error(`Question index out of range: ${next}`);
  state.currentQuestionIndex = next;
}

export function moveQuestionOption(state: QuestionRequestState, delta: number): void {
  const index = state.currentQuestionIndex;
  const question = state.questions[index];
  if (!question) throw new Error(`Question index out of range: ${index}`);
  const selectableCount = question.options.length + (question.custom ? 1 : 0);
  if (selectableCount === 0) return;
  const current = state.highlightedOptionIndices[index] ?? 0;
  const next = Math.min(Math.max(current + delta, 0), selectableCount - 1);
  state.highlightedOptionIndices[index] = next;
}

export function toggleCurrentQuestionOption(state: QuestionRequestState): void {
  const index = state.currentQuestionIndex;
  const question = state.questions[index];
  if (!question) throw new Error(`Question index out of range: ${index}`);
  const optionIndex = state.highlightedOptionIndices[index] ?? 0;
  const option = question.options[optionIndex];
  if (!option) {
    if (question.custom && optionIndex === question.options.length) {
      state.editingCustomIndex = index;
      return;
    }
    if (!question.options.length) return;
    throw new Error(
      `Question option index out of range: ${state.highlightedOptionIndices[index] ?? 0}`,
    );
  }
  const selected = state.selectedAnswers[index] ?? [];
  if (question.multiple) {
    state.selectedAnswers[index] = selected.includes(option.label)
      ? selected.filter((label) => label !== option.label)
      : [...selected, option.label];
  } else {
    state.selectedAnswers[index] = selected.includes(option.label) ? [] : [option.label];
  }
  state.dirty = true;
}

export function questionProgress(state: QuestionRequestState): string {
  const total = state.questions.length;
  if (total === 0) return "0/0";
  return `${state.currentQuestionIndex + 1}/${total}`;
}

export function finalizeQuestionRequest(
  state: QuestionRequestState,
): Array<{ question: string; answers: string[]; customAnswer: string }> {
  return state.questions.map((question, index) => ({
    question: question.question,
    answers: state.selectedAnswers[index] ?? [],
    customAnswer: state.customAnswers[index] ?? "",
  }));
}

export function buildQuestionAnswerPrompt(state: QuestionRequestState): string {
  const answers = finalizeQuestionRequest(state).map((item, index) => {
    const selected = item.answers.length ? item.answers.join(", ") : "(no selected option)";
    const custom = item.customAnswer ? `\nCustom answer: ${item.customAnswer}` : "";
    return `${index + 1}. ${item.question}\nSelected answers: ${selected}${custom}`;
  });
  return [`Question request ${state.requestId} answered by user:`, ...answers].join("\n");
}

export function buildQuestionRejectionPrompt(state: QuestionRequestState): string {
  return `Question request ${state.requestId} was rejected by user.`;
}
