import { openDB, type DBSchema } from "idb";
import type { StudyContent } from "../../shared/content";
export type Draft = {
  version: 1;
  userId: string;
  key: string;
  baseRevision: number | null;
  content: StudyContent;
  updatedAt: number;
};
interface DraftDB extends DBSchema {
  drafts: { key: [string, string]; value: Draft; indexes: { account: string } };
}
const database = () =>
  openDB<DraftDB>("exam-prep-drafts", 1, {
    upgrade(db) {
      const store = db.createObjectStore("drafts", {
        keyPath: ["userId", "key"],
      });
      store.createIndex("account", "userId");
    },
  });
export const getDraft = async (userId: string, key: string) =>
  (await database()).get("drafts", [userId, key]);
export const putDraft = async (draft: Draft) =>
  (await database()).put("drafts", draft);
export const removeDraft = async (userId: string, key: string) =>
  (await database()).delete("drafts", [userId, key]);
export const accountDrafts = async (userId: string) =>
  (await database()).getAllFromIndex("drafts", "account", userId);
export async function clearDrafts(userId: string) {
  const db = await database();
  const tx = db.transaction("drafts", "readwrite");
  const keys = await tx.store.index("account").getAllKeys(userId);
  await Promise.all(keys.map((key) => tx.store.delete(key)));
  await tx.done;
}
