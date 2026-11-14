import {
  itemsOf,
  type StudyContent,
  type Question,
} from "../../shared/content";
import {
  answered,
  maximum,
  mistakes,
  own,
  retrySnapshot,
  writtenScore,
  type Response,
  type Responses,
  type Status,
} from "../../shared/attempts";
import type {
  ExamMapItem,
  ExamQuestionStatus,
} from "../components/ExamQuestionMap";

export function summarizePractice(
  doc: StudyContent,
  responses: Responses,
  stage: Status,
) {
  const items = itemsOf(doc);
  const isExam = doc.kind === "exam";
  const inProgress = stage === "in_progress";
  const eligible = stage === "completed" ? mistakes(doc, responses) : null;
  const retryCount = eligible ? itemsOf(eligible).length : 0;
  const flagged =
    !isExam || !inProgress ? retrySnapshot(doc, responses, "flagged") : null;
  const uncertain =
    !isExam || !inProgress
      ? retrySnapshot(doc, responses, "low_confidence")
      : null;
  const incorrectIds = new Set(
    eligible ? itemsOf(eligible).map((i) => i.id) : [],
  );
  const examMapItems = isExam
    ? doc.questions.map((question): ExamMapItem => {
        const answer = own(responses, question.id);
        return {
          id: question.id,
          status: examQuestionStatus(question, answer, stage),
          flagged: answer?.flagged === true,
          lowConfidence: answer?.confidence === "low",
          mistake: incorrectIds.has(question.id),
        };
      })
    : [];
  const pending = examMapItems.flatMap(({ status }, index) =>
    status === "Needs assessment" ? [index] : [],
  );
  const writtenAnswered =
    doc.kind === "exam"
      ? doc.questions.filter(
          (q) => q.type === "written" && answered(q, own(responses, q.id)),
        ).length
      : 0;
  const omissions = items.flatMap((it, i) =>
    (
      "type" in it
        ? !answered(it, own(responses, it.id))
        : !own(responses, it.id)?.rating
    )
      ? [i]
      : [],
  );
  const unanswered = omissions.length;
  const flaggedCount = examMapItems.filter(
    (question) => question.flagged,
  ).length;
  const firstMistake = examMapItems.findIndex((question) => question.mistake);

  return {
    retryCount,
    flagged,
    uncertain,
    incorrectIds,
    examMapItems,
    pending,
    writtenAnswered,
    omissions,
    unanswered,
    flaggedCount,
    firstMistake,
  };
}

function examQuestionStatus(
  question: Question,
  response: Response | undefined,
  stage: Status,
): ExamQuestionStatus {
  if (!answered(question, response)) return "Unanswered";
  if (stage === "in_progress") return "Answered";
  if (question.type === "single_choice")
    return response?.selectedOptionId === question.answer
      ? "Correct"
      : "Incorrect";
  const score = writtenScore(question, response);
  if (score === null) return "Needs assessment";
  if (stage === "reviewing") return "Assessed";
  if (score === maximum(question)) return "Correct";
  return score > 0 ? "Partial credit" : "Incorrect";
}
