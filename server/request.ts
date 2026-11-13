import type { z } from "zod";
import {
  decodeFile,
  MAX_BYTES,
  parseJSON,
  ValidationError,
} from "../shared/json";

export function schema<T>(validator: z.ZodType<T>, value: unknown): T {
  const parsed = validator.safeParse(value);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((issue) => ({
        path: "/" + issue.path.join("/"),
        message: issue.message,
      })),
    );
  return parsed.data;
}

export async function read(request: Request, max = MAX_BYTES + 1024) {
  return parseJSON(decodeFile(await request.arrayBuffer(), max), max);
}
