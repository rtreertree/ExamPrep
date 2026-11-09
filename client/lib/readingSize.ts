const sizes = { standard: 1, large: 1.25, "extra-large": 1.5 };
export type ReadingSize = keyof typeof sizes;
const key = (userId: string) => `examprep-reading-size-v1:${userId}`;

export function readingSize(userId: string): ReadingSize {
  try {
    const value = localStorage.getItem(key(userId));
    if (value && Object.hasOwn(sizes, value)) return value as ReadingSize;
  } catch {
    // The default remains available when storage is blocked.
  }
  return "standard";
}
export function applyReadingSize(size: ReadingSize) {
  document.documentElement.style.setProperty(
    "--study-scale",
    String(sizes[size]),
  );
}
export function saveReadingSize(userId: string, size: ReadingSize) {
  applyReadingSize(size);
  try {
    localStorage.setItem(key(userId), size);
  } catch {
    // The current page can still use the chosen size.
  }
}
export function clearReadingSize(userId: string) {
  localStorage.removeItem(key(userId));
}
