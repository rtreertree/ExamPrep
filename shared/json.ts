export const MAX_BYTES = 2_097_152;
export type Issue = { path: string; message: string };
export class ValidationError extends Error {
  constructor(
    public issues: Issue[],
    public status = 422,
  ) {
    super(issues.map((i) => `${i.path || "/"}: ${i.message}`).join("\n"));
  }
}
export const pointer = (path: (string | number | symbol)[]) =>
  "/" +
  path
    .map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");

/** A bounded recursive JSON parser: detects duplicate decoded keys before data is lost. */
export function parseJSON(source: string, limit = MAX_BYTES): unknown {
  if (new TextEncoder().encode(source).length > limit)
    throw new ValidationError(
      [{ path: "/", message: "File exceeds 2 MiB." }],
      413,
    );
  let i = 0;
  const fail = (message: string, path: (string | number)[] = []): never => {
    const lines = source.slice(0, i).split("\n");
    throw new ValidationError([
      {
        path: pointer(path),
        message: `${message} (line ${lines.length}, column ${lines.at(-1)!.length + 1}).`,
      },
    ]);
  };
  const ws = () => {
    while (/[\t\n\r ]/.test(source[i] ?? "\0")) i++;
  };
  function string(): string {
    const start = i++;
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i++] === '"') {
        try {
          return JSON.parse(source.slice(start, i));
        } catch {
          fail("Invalid JSON string");
        }
      }
    }
    return fail("Unterminated string");
  }
  function value(path: (string | number)[], depth: number): unknown {
    if (depth > 64) fail("JSON nesting is too deep", path);
    ws();
    if (source[i] === '"') return string();
    if (source[i] === "{") {
      i++;
      ws();
      const object = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (source[i] === "}") {
        i++;
        return object;
      }
      while (i < source.length) {
        ws();
        if (source[i] !== '"') fail("Expected a quoted property name", path);
        const key = string();
        if (keys.has(key))
          fail(`Duplicate object key "${key}"`, [...path, key]);
        keys.add(key);
        ws();
        if (source[i++] !== ":") fail("Expected a colon", path);
        object[key] = value([...path, key], depth + 1);
        ws();
        const end = source[i++];
        if (end === "}") return object;
        if (end !== ",") fail("Expected comma or closing brace", path);
      }
      fail("Unterminated object", path);
    }
    if (source[i] === "[") {
      i++;
      ws();
      const array: unknown[] = [];
      if (source[i] === "]") {
        i++;
        return array;
      }
      while (i < source.length) {
        array.push(value([...path, array.length], depth + 1));
        ws();
        const end = source[i++];
        if (end === "]") return array;
        if (end !== ",") fail("Expected comma or closing bracket", path);
      }
      fail("Unterminated array", path);
    }
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(word, i)) {
        i += word.length;
        return result;
      }
    }
    const match = source
      .slice(i)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match) {
      i += match[0].length;
      const n = Number(match[0]);
      if (!Number.isFinite(n)) fail("Number must be finite", path);
      return n;
    }
    return fail("Expected a JSON value", path);
  }
  const result = value([], 0);
  ws();
  if (i !== source.length) fail("Unexpected trailing content");
  return result;
}
export function decodeFile(bytes: ArrayBuffer, limit = MAX_BYTES): string {
  if (bytes.byteLength > limit)
    throw new ValidationError(
      [{ path: "/", message: "File exceeds 2 MiB." }],
      413,
    );
  const data = new Uint8Array(bytes);
  if (data[0] === 239 && data[1] === 187 && data[2] === 191)
    throw new ValidationError([
      { path: "/", message: "UTF-8 byte-order marks are not allowed." },
    ]);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new ValidationError([
      { path: "/", message: "File must be valid UTF-8." },
    ]);
  }
}
