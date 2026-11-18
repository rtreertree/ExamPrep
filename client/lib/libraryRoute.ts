export function libraryReturnPath(previous: unknown) {
  if (typeof previous === "string") {
    if (previous.startsWith("/library?")) return previous;
    // Browser history can still contain return links from before the move.
    if (previous.startsWith("/?")) return `/library${previous.slice(1)}`;
  }
  return "/library";
}
