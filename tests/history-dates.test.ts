import { describe, expect, it } from "vitest";
import { historyDateBounds } from "../client/lib/historyDates";

describe("History calendar date filters", () => {
  it("includes today and the previous six calendar days", () => {
    const now = new Date(2026, 10, 3, 13);
    expect(historyDateBounds("7", "", "", now)).toEqual({
      startedFrom: new Date(2026, 9, 28).toISOString(),
      startedBefore: new Date(2026, 10, 4).toISOString(),
    });
  });

  it("accepts either custom bound and includes the full end date", () => {
    expect(historyDateBounds("custom", "2026-02-28", "").startedFrom).toBe(
      new Date(2026, 1, 28).toISOString(),
    );
    expect(historyDateBounds("custom", "", "2026-02-28").startedBefore).toBe(
      new Date(2026, 2, 1).toISOString(),
    );
    expect(
      historyDateBounds("custom", "2026-02-28", "2026-02-28").error,
    ).toBeUndefined();
    expect(historyDateBounds("custom", "2026-02-29", "").error).toBe(
      "Enter a valid date.",
    );
    expect(historyDateBounds("custom", "2026-03-01", "2026-02-28").error).toBe(
      "Start date must be on or before end date.",
    );
  });
});
