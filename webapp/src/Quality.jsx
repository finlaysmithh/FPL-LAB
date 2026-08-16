import React from "react";
import { DATA, fdrLabel } from "./logic.js";
import { weekQuality } from "./manager.js";
import { squadQuality } from "./decide.js";

/**
 * TWO SCORES, AND WHAT THEY MEAN.
 *
 * The complaint this answers is exact and fair: "72 is hard to tell if it's
 * actually competitive or if it's gonna be a weak team — depending on how
 * harsh the scoring is." A mark out of a hundred is uninterpretable without
 * its anchors, and every score in this app was being shown without them.
 *
 * So the scale is drawn, not asserted. The bar carries two labelled ticks:
 *
 *     TEMPLATE   the most-owned legal fifteen — very nearly the median
 *                manager's team, and 50 by construction
 *     CEILING    the best eleven your budget can field that week, and 100
 *
 * Which turns an opaque 72 into a sentence anyone can act on: you are above
 * the field by four points this week and three short of the best available.
 *
 * THIS WEEK scores the ELEVEN, because that is what scores points on
 * Saturday. NEXT SIX scores the fifteen over the horizon, because that is
 * what a transfer plan is about. They answer different questions and are
 * deliberately not averaged into one number.
 */

const pts = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1);

function Scale({ q }) {
  // Where the marker sits, clamped so it stays inside the track.
  const at = Math.max(3, Math.min(97, q.score));
  return (
    <div className="ql-scale">
      <div className="ql-track">
        <span className="ql-tick" style={{ left: "50%" }} />
        <div className="ql-fill" style={{ width: `${at}%`, background: q.band.c }} />
        <span className="ql-marker" style={{ left: `${at}%`, background: q.band.c }} />
      </div>
      <div className="ql-legend">
        <span>Template<i>50</i></span>
        <span className="r">Best available<i>100</i></span>
      </div>
    </div>
  );
}

export function QualityPanel({ squad, gi, capt }) {
  const now = React.useMemo(() => weekQuality(squad, gi), [squad.join(","), gi]);
  const run = React.useMemo(() => squadQuality(squad, gi, capt), [squad.join(","), gi, capt]);
  if (!now && !run) return null;

  return (
    <section className="ql">
      <h2 className="ql-h">Squad quality</h2>

      <div className="ql-cards">
        {now && now.score != null && (
          <div className="ql-card">
            <div className="ql-card-k">
              This week<em>GW{now.gw} · your eleven</em>
            </div>
            <div className="ql-n" style={{ color: now.band.c }}>
              {now.score}<i>/100</i>
              <span className="ql-band" style={{ color: now.band.c }}>{now.band.label}</span>
            </div>
            <Scale q={now} />
            <p className="ql-say">
              Your {now.formation} projects <b>{now.pts.toFixed(1)}</b>.
              {" "}That is <b>{pts(now.vsField)}</b> against the template manager
              {now.vsCeiling != null && <> and <b>{pts(now.vsCeiling)}</b> against the best eleven your budget could field</>}.
              {now.fdr != null && (
                <> Fixtures this week are <b>{fdrLabel(now.fdr).toLowerCase()}</b> on average.</>
              )}
            </p>
          </div>
        )}

        {run && (
          <div className="ql-card">
            <div className="ql-card-k">
              Next six<em>GW{run.weeks[0]}–{run.weeks[run.weeks.length - 1]} · all fifteen</em>
            </div>
            <div className="ql-n" style={{ color: run.band.c }}>
              {run.score}<i>/100</i>
              <span className="ql-band" style={{ color: run.band.c }}>{run.band.label}</span>
            </div>
            <div className="ql-scale">
              <div className="ql-track">
                <div className="ql-fill" style={{ width: `${run.score}%`, background: run.band.c }} />
                <span className="ql-marker" style={{ left: `${Math.max(3, Math.min(97, run.score))}%`, background: run.band.c }} />
              </div>
              <div className="ql-legend">
                <span>Weak<i>0</i></span>
                <span className="r">Best your budget allows<i>100</i></span>
              </div>
            </div>
            <p className="ql-say">
              <b>{run.points.toFixed(0)}</b> projected across the run against a
              ceiling of <b>{run.ceiling.toFixed(0)}</b> — you are capturing{" "}
              <b>{Math.round(run.ratio * 100)}%</b> of what this budget can buy.
              {run.depth && <> Bench cover is {run.depth.playable}/4.</>}
            </p>
          </div>
        )}
      </div>

      <p className="ql-note">
        Fifty is the most-owned fifteen in the game — very nearly what the median
        manager fields — so anything above it is beating the field. A hundred is
        the best team your budget could actually buy that week, not a fantasy,
        which is why closing the last few points is so much harder than the
        first.
      </p>
    </section>
  );
}
