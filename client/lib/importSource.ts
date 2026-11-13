export function unwrapPastedJSON(source: string) {
  const fence =
    /^[\t\r\n ]*(`{3,}|~{3,})(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*\1[\t\r\n ]*$/i.exec(
      source,
    );
  return fence?.[2] ?? source;
}
