import { expect, it } from "vitest";
import { encodeStorage, decodeStorage } from "../server/storage";
it("preserves every string through the PostgreSQL storage escape boundary", () => {
  for (const value of [
    "~",
    "~7e; ~u0000;",
    "\0",
    "\uD800",
    "\uDFFF",
    "🦊 สมการ $\\int x$",
    "a\0b~c\uD800d",
  ]) {
    const encoded = encodeStorage({ title: value, nested: [{ text: value }] });
    expect(decodeStorage(encoded)).toEqual({
      title: value,
      nested: [{ text: value }],
    });
    expect(encoded.title).not.toContain("\0");
  }
});

it("escapes prototype-sensitive map keys before ORM serialization without changing the public record", () => {
  const input = JSON.parse(
    '{"__proto__":{"criterionPoints":{"__proto__":10}},"~proto;":"literal"}',
  );
  const stored = encodeStorage(input);
  expect(Object.hasOwn(stored, "__proto__")).toBe(false);
  expect(decodeStorage(stored)).toEqual(input);
});
