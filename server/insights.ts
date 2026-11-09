import { mistakes, own, type Responses, type Result } from "../shared/attempts";
import { itemsOf } from "../shared/content";
import type { ProgressInsights } from "../shared/insights";
import type { Database } from "./db";
import { readProgressContent } from "./snapshots";
import { decodeStorage } from "./storage";

export async function readInsights(
  db: Pick<Database, "$queryRaw">,
  userId: string,
  setId: string | null,
): Promise<ProgressInsights> {
  const [scoreRows, recentRows, pendingRows] = await Promise.all([
    db.$queryRaw<
      {
        setId: string;
        title: string;
        revision: number;
        id: string;
        completedAt: Date;
        result: Result;
      }[]
    >`
      WITH groups AS (
        SELECT "studySetId", "studySetRevision", MAX("completedAt") AS latest
        FROM "Attempt"
        WHERE "userId" = ${userId} AND status = 'completed'
          AND "fullSet" AND "sourceAttemptId" IS NULL AND snapshot->>'kind' = 'exam'
          AND "studySetId" IS NOT NULL AND "studySetRevision" IS NOT NULL
          AND (${setId}::text IS NULL OR "studySetId" = ${setId}::text)
        GROUP BY "studySetId", "studySetRevision"
        HAVING COUNT(*) >= 2
        ORDER BY latest DESC, "studySetId", "studySetRevision" DESC LIMIT 3
      )
      SELECT g."studySetId" AS "setId", g."studySetRevision" AS revision,
        s.id, s.title, s.result, s."completedAt"
      FROM groups g CROSS JOIN LATERAL (
        SELECT id, snapshot->>'title' AS title, result, "completedAt"
        FROM "Attempt"
        WHERE "userId" = ${userId} AND status = 'completed' AND "fullSet"
          AND "sourceAttemptId" IS NULL AND snapshot->>'kind' = 'exam'
          AND "studySetId" = g."studySetId" AND "studySetRevision" = g."studySetRevision"
        ORDER BY "completedAt" DESC, id ASC LIMIT 6
      ) s ORDER BY g.latest DESC, g."studySetId", g."studySetRevision" DESC, s."completedAt" DESC, s.id
    `,
    db.$queryRaw<
      {
        id: string;
        setId: string | null;
        setRevision: number | null;
        title: string;
        rules: unknown;
        responses: Responses | null;
      }[]
    >`
      WITH recent AS (
        SELECT id, "studySetId", "studySetRevision", "progressContent", snapshot->>'title' AS title,
          responses, "completedAt"
        FROM "Attempt"
        WHERE "userId" = ${userId} AND status = 'completed' AND "progressContent" IS NOT NULL
          AND (${setId}::text IS NULL OR "studySetId" = ${setId}::text)
        ORDER BY "completedAt" DESC, id LIMIT 30
      )
      SELECT id, "studySetId" AS "setId", "studySetRevision" AS "setRevision", title,
        "progressContent" AS rules,
        (SELECT jsonb_object_agg(key, jsonb_strip_nulls(jsonb_build_object(
          'selectedOptionId', value->'selectedOptionId', 'selfAssessment', value->'selfAssessment',
          'criterionPoints', value->'criterionPoints', 'rating', value->'rating',
          'text', CASE WHEN value ? 'selfAssessment' OR value ? 'criterionPoints' THEN 'answered' END
        ))) FROM jsonb_each(responses)) AS responses
      FROM recent ORDER BY "completedAt" DESC, id
    `,
    db.$queryRaw<{ attemptId: string; sessions: number; answers: number }[]>`
      SELECT id AS "attemptId", (COUNT(*) OVER ())::int AS sessions,
        (SUM(COALESCE((result->'selfAssessed'->>'pendingCount')::int, 0)) OVER ())::int AS answers
      FROM "Attempt" WHERE "userId" = ${userId} AND status = 'reviewing'
        AND (${setId}::text IS NULL OR "studySetId" = ${setId}::text)
      ORDER BY "updatedAt" DESC, id LIMIT 1
    `,
  ]);

  const trends = new Map<string, ProgressInsights["trends"][number]>();
  for (const score of decodeStorage(scoreRows)) {
    const key = JSON.stringify([score.setId, score.revision]);
    let group = trends.get(key);
    if (!group) {
      group = {
        setId: score.setId,
        title: score.title,
        revision: score.revision,
        scores: [],
      };
      trends.set(key, group);
    }
    group.scores.unshift({
      id: score.id,
      completedAt: score.completedAt.toISOString(),
      result: score.result,
    });
  }

  const repeated = new Map<
    string,
    Omit<ProgressInsights["recurring"][number], "prompt">
  >();
  const latestOutcomes = new Set<string>();
  let retry: ProgressInsights["retry"] = null;
  for (const row of decodeStorage(recentRows)) {
    const rules = readProgressContent(row.rules);
    const responses = row.responses ?? {};
    const missed = mistakes(rules, responses);
    const missedItems = missed ? itemsOf(missed) : [];
    if (!row.setId || row.setRevision === null) {
      if (missedItems.length)
        retry ??= {
          attemptId: row.id,
          title: row.title,
          count: missedItems.length,
        };
      continue;
    }
    const itemKey = (id: string) =>
      JSON.stringify([row.setId, row.setRevision, id]);
    if (
      !retry &&
      missedItems.some(({ id }) => !latestOutcomes.has(itemKey(id)))
    )
      retry = {
        attemptId: row.id,
        title: row.title,
        count: missedItems.length,
      };
    for (const item of missedItems) {
      const key = itemKey(item.id);
      const entry = repeated.get(key);
      if (entry) entry.misses++;
      else
        repeated.set(key, {
          attemptId: row.id,
          itemId: item.id,
          setTitle: row.title,
          misses: 1,
        });
    }
    for (const { id } of itemsOf(rules)) {
      if (rules.kind === "exam" || own(responses, id)?.rating)
        latestOutcomes.add(itemKey(id));
    }
  }
  const recurring = [...repeated.values()]
    .filter((item) => item.misses >= 2)
    .sort((a, b) => b.misses - a.misses)
    .slice(0, 5);
  const prompts = recurring.length
    ? await db.$queryRaw<
        { attemptId: string; itemId: string; prompt: string }[]
      >`
        SELECT w."attemptId", w."itemId", LEFT(COALESCE(i.item->>'prompt', i.item->>'front'), 240) AS prompt
        FROM jsonb_to_recordset(${JSON.stringify(recurring)}::jsonb) AS w("attemptId" text, "itemId" text)
        JOIN "Attempt" a ON a.id = w."attemptId" AND a."userId" = ${userId}
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.snapshot->'questions', a.snapshot->'cards')) AS i(item)
        WHERE i.item->>'id' = w."itemId"
      `
    : [];
  return {
    trends: [...trends.values()],
    recurring: recurring.map((item) => ({
      ...item,
      prompt: decodeStorage(
        prompts.find(
          (p) => p.attemptId === item.attemptId && p.itemId === item.itemId,
        )?.prompt ?? item.itemId,
      ),
    })),
    pending: pendingRows[0] ?? null,
    retry,
  };
}
