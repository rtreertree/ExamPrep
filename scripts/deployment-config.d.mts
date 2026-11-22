export function databaseConnection(
  value: string | undefined,
  pooled: boolean,
  name?: string,
): URL;
export function checkConnections(
  env: Record<string, string | undefined>,
  names?: { runtime?: string; migration?: string },
): {
  runtime: URL;
  migration: URL;
};
export function productionConfig(env: Record<string, string | undefined>): void;
