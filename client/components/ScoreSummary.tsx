import type { Result } from "../../shared/attempts";
export function ScoreSummary({ result }: { result: Result | null }) {
  if (!result) return null;
  return (
    <div className="score-summary">
      {(["automatic", "selfAssessed"] as const).map((key) =>
        result[key] ? (
          <div className="score-group" key={key}>
            <span className="muted">
              {key === "automatic" ? "Automatic score" : "Self-assessed score"}
            </span>
            <strong>
              {result[key]!.earnedPoints}
              <span> / {result[key]!.maxPoints}</span>
            </strong>
            {result[key]!.pendingCount ? (
              <span className="warning">
                {result[key]!.pendingCount} pending assessment
              </span>
            ) : null}
          </div>
        ) : null,
      )}
      {result.known !== undefined ? (
        <>
          {[
            ["Known", result.known],
            ["Review again", result.reviewAgain],
            ["Unreviewed", result.unreviewed],
          ].map(([label, count]) => (
            <div className="score-group" key={label}>
              <span className="muted">{label}</span>
              <strong>{count}</strong>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
