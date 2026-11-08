const databaseCodes = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2002",
  "P2024",
  "P2034",
]);
export function safeDiagnostic(
  error: unknown,
  context: {
    requestId: string;
    route: string;
    runtime: string;
    durationMs: number;
  },
) {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return {
    event: "request_failed",
    ...context,
    status: 500,
    category:
      typeof code === "string" && databaseCodes.has(code)
        ? "database"
        : "unexpected",
    ...(typeof code === "string" && databaseCodes.has(code) ? { code } : {}),
  };
}
