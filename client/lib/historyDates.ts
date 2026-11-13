export const historyDateOptions = [
  { value: "any", label: "Any date" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom dates" },
] as const;

export type HistoryDateFilter = (typeof historyDateOptions)[number]["value"];

function localDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year === 0) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

function nextDay(date: Date) {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function historyDateBounds(
  mode: HistoryDateFilter,
  from: string,
  through: string,
  now = new Date(),
) {
  if (mode === "any") return {};
  if (mode === "custom") {
    const start = localDate(from);
    const end = localDate(through);
    if ((from && !start) || (through && !end))
      return { error: "Enter a valid date." };
    if (start && end && start > end)
      return { error: "Start date must be on or before end date." };
    return {
      startedFrom: start?.toISOString(),
      startedBefore: end && nextDay(end).toISOString(),
    };
  }
  const start = new Date(now);
  start.setDate(start.getDate() - Number(mode) + 1);
  start.setHours(0, 0, 0, 0);
  return {
    startedFrom: start.toISOString(),
    startedBefore: nextDay(now).toISOString(),
  };
}
