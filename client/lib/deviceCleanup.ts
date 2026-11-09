import { clearDrafts } from "./drafts";
import { clearAISettings } from "./aiSettings";
import { clearPracticeCheckpoints } from "./practiceRecovery";
import { clearListQueries } from "./listQuery";
import { clearReadingSize } from "./readingSize";
/** Storage can hang as well as reject. A completed server sign-out must stay usable. */
export async function clearDeviceData(userId: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled([
        clearDrafts(userId),
        clearPracticeCheckpoints(userId),
        Promise.resolve().then(() => clearAISettings(userId)),
        Promise.resolve().then(() => clearListQueries(userId)),
        Promise.resolve().then(() => clearReadingSize(userId)),
      ]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Device cleanup timed out.")),
          3000,
        );
      }),
    ]);
    if (results.some((r) => r.status === "rejected"))
      throw new Error("Device cleanup is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}
