/**
 * JSONB/text reject NUL and isolated UTF-16 surrogates that JSON can encode.
 * Escape at the persistence boundary, not in the portable document. Escaping all
 * tildes makes this bijective, including literal strings resembling our escapes.
 * Escape prototype-sensitive map keys before Prisma serializes JSON arguments.
 */
export function encodeStorage<T>(value: T): T {
  if (typeof value === "string")
    return value.replace(
      /~|\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
      (char) =>
        char === "~"
          ? "~7e;"
          : `~u${char.charCodeAt(0).toString(16).padStart(4, "0")};`,
    ) as T;
  if (Array.isArray(value)) return value.map(encodeStorage) as T;
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === "__proto__" ? "~proto;" : encodeStorage(k),
        encodeStorage(v),
      ]),
    ) as T;
  return value;
}
export function decodeStorage<T>(value: T): T {
  if (typeof value === "string")
    return value.replace(/~(?:7e|u[0-9a-f]{4});/g, (token) =>
      token === "~7e;"
        ? "~"
        : String.fromCharCode(parseInt(token.slice(2, -1), 16)),
    ) as T;
  if (Array.isArray(value)) return value.map(decodeStorage) as T;
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === "~proto;" ? "__proto__" : decodeStorage(k),
        decodeStorage(v),
      ]),
    ) as T;
  return value;
}
