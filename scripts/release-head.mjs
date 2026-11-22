import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const commitSha = /^[0-9a-f]{40}$/;

export async function isCurrentMain(env) {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN } = env;
  if (
    !GITHUB_API_URL ||
    !GITHUB_REPOSITORY ||
    !commitSha.test(GITHUB_SHA ?? "") ||
    !GH_TOKEN
  )
    throw new Error("The GitHub commit or read-only token is missing.");

  let main;
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/git/ref/heads/main`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${GH_TOKEN}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.ok) main = await response.json();
  } catch {
    // Fail closed with a safe diagnostic if GitHub cannot confirm the ref.
  }
  if (
    main?.ref !== "refs/heads/main" ||
    !commitSha.test(main.object?.sha ?? "")
  )
    throw new Error("GitHub could not verify the current main commit.");
  return main.object.sha === GITHUB_SHA;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const current = await isCurrentMain(process.env);
    await appendFile(process.env.GITHUB_OUTPUT, `current=${current}\n`);
    if (!current) {
      const message =
        "Main advanced. This commit was superseded before production preflight.";
      if (process.argv.includes("--require-current")) throw new Error(message);
      console.info(`::notice::${message}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
