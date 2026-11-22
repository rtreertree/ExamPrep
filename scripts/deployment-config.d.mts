export function databaseConnection(
  value: string | undefined,
  pooled: boolean,
): URL;
export function checkConnections(env: Record<string, string | undefined>): void;
export function productionConfig(env: Record<string, string | undefined>): void;
