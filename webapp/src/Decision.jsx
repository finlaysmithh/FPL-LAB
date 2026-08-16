import React, { useState } from "react";
import { DATA } from "./logic.js";
import { gameweekDecision, qualityBand, readiness } from "./decide.js";
import { gradeFor, gradeTone, weekRating } from "./logic.js";

/**
 * The decision terminal.
 *
 * Replaces five competing scores out of 100 with three answers, in the order a
 * manager actually needs them: what to do now, how good the plan is, and when
 * to look again. Everything else on the page is supporting evidence and reads
 * as such.
 *
 * The design rule throughout: a number is only shown if a different value
 * would change what the user does.
 */

const pct = (v) => `${Math.round(v * 100)}%`;
const sign = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);

const VERDICT = {
  ACT: { c: "#00FF87", ink: "#062a17", word: "ACT" },
  CONSIDER: { c: "#F5C542", ink: "#2a2206", word: "CONSIDER" },
  HOLD: { c: "#6CC7FF", ink: "#04202e", word: "HOLD" },
};

const CHIP_STATE = {
  PLAY: { label: "PLAY NOW", c: "#00FF87" },
  WINDOW: { label: "WINDOW", c: "#F5C542" },
  OPEN: { label: "OPEN", c: "#947ca6" },
};

function Score({ label, value, band, sub }) {
  return (
    <div className="dq-score">
      <div className="dq-score-k">{label}</div>
      <div className="dq-score-v" style={{ color: band.c }}>
        {value}<i>/100</i>
      </div>
      <div className="dq-score-bar">
        <div style={{ width: `${value}%`, background: band.c }} />
      </div>
      <div className="dq-score-b" style={{ color: band.c }}>{band.label}</div>
      {sub && <div className="dq-score-s">{sub}</div>}
    </div>
  );
}

// Split in two so the PITCH can sit between the halves.
//
// `part="head"` is the only thing that earns a place above the eleven shirts:
// what to do, and whether the squad is ready to play. Everything else — the
// option table, the chip plan, the transfer suggestions — is commentary on a
// team the user has not seen yet if it comes first, so it renders below.
export function DecisionPanel({ squad, capt, gi, free = 1, part = "all", children }) {
  const [openChips, setOpenChips] = useState(false);
  const d = gameweekDecision(squad, gi, capt, free);
  if (!d) return null;

  const v = VERDICT[d.verdict];
  const plan = d.plan;
  const q = plan.squad;
  const maxWeek = Math.max(...plan.weekly.map((w) => w.pts), 1);

  return (
    <div className="dq">
      {/* ---- how good is it ----------------------------------------- */}
      {/* THE VERDICT HAS MOVED. It, the option table and the chip plan now live
          in one place — the plan bar at the top of the page — because three
          panels answering "what should I do this week" is how a page ends up
          printing "Roll your transfer" immediately above "ACT: Play Bench
          Boost". What is left here is the part that was never duplicated: how
          good the squad is, and whether it is ready to play. */}
      {part !== "body" && (<>
      {/* Squad quality only. "Plan quality" is a statement about the PLAN, not
          the team, so it belongs with the gaffer's reasoning below rather than
          competing for attention with the team's own score. */}
      <div className="dq-scores solo">
        <Score label="Squad quality" value={q.score} band={q.band}
          sub={`${q.points.toFixed(0)} projected pts over GW${q.weeks[0]}–${q.weeks[q.weeks.length - 1]}`} />
      </div>

      {/* What the number MEANS. 71/100 is a good squad and reads like a poor
          exam mark; without this a user cannot tell "good enough, play it"
          from "fix two things before the deadline". */}
      <p className="dq-ready">{readiness(q.score)}</p>

      </>)}

      {part === "head" ? null : (<>
      <div className="dq-scores solo">
        <Score label="Plan quality" value={plan.score} band={plan.band}
          sub={plan.bestNet > 0.8
            ? `${plan.bestNet.toFixed(1)} net pts still on the table`
            : "Nothing significant left on the table"} />
      </div>

      {/* ---- 4. outlook + next decision ------------------------------ */}
      <div className="dq-block">
        <div className="dq-block-k">
          Outlook · GW{plan.horizon[0]}–{plan.horizon[plan.horizon.length - 1]}
          {(() => {
            // An overall grade for the run, from the AVERAGE week rather than
            // the total — a six-week total and a ten-week total are different
            // magnitudes and cannot share a scale. Graded against the same
            // anchors as everything else: the template manager is C.
            const avg = plan.weekly.reduce((t, w) => t + w.pts, 0)
              / Math.max(1, plan.weekly.length);
            const g = gradeFor(weekRating(avg));
            return (
              <span className={`dq-grade g-${gradeTone(g)}`} title={`${avg.toFixed(1)} pts a gameweek`}>
                {g}
              </span>
            );
          })()}
          <span className="dq-total">{plan.points.toFixed(0)} pts</span>
        </div>
        <div className="dq-spark">
          {plan.weekly.map((w) => {
            const g = gradeFor(weekRating(w.pts));
            return (
            <div key={w.gw} className="dq-sp">
              <div className="dq-sp-bar">
                <div style={{ height: `${(w.pts / maxWeek) * 100}%` }} />
              </div>
              <span className={`dq-sp-gr g-${gradeTone(g)}`}>{g}</span>
              <span className="dq-sp-v">{w.pts.toFixed(0)}</span>
              <span className="dq-sp-g">{w.gw}</span>
            </div>
            );
          })}
        </div>
        {d.next && (
          <div className="dq-next">
            <b>Reassess GW{d.next.gw}</b> — {d.next.why}.
          </div>
        )}
      </div>

      {/* The ONE place transfer suggestions live. They used to appear here in
          spirit and again twice further down the page under their own
          headings, which is the same advice in three wrappers — a user cannot
          tell whether three sections disagree or repeat. */}
      {children}
      </>)}
    </div>
  );
}
