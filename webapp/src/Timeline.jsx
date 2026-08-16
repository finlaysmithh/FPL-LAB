import React from "react";
import { DATA } from "./logic.js";
import { CHIPS } from "./plan.js";

// The season as one strip.
//
// This replaces a row of six pills that sat in the top-left corner and looked
// like a leftover control. A plan is a sequence, so the navigation for it
// should BE the sequence — every gameweek across the width, each carrying what
// is committed to it, with the week you are editing raised out of the line.
//
// It is doing three jobs at once and that is deliberate: choose a week, see the
// projected score for each, and read the plan without opening anything.
export function Timeline({ gi, setGi, weeks }) {
  const pts = weeks.map((w) => w.points);
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const span = Math.max(1e-6, hi - lo);

  return (
    <div className="tl">
      <div className="tl-head">
        <span className="tl-k">Season plan</span>
        <span className="tl-legend">
          <i className="tl-dot chip" /> chip
          <i className="tl-dot tx" /> transfer
          <i className="tl-dot lock" /> locked
        </span>
      </div>
      <div className="tl-strip" role="tablist" aria-label="Gameweek">
        {weeks.map((w) => {
          const chip = w.chip && CHIPS.find((c) => c[0] === w.chip);
          const h = 22 + ((w.points - lo) / span) * 30;
          return (
            <button key={w.k} role="tab" aria-selected={w.k === gi}
              className={`tl-w ${w.k === gi ? "on" : ""} ${w.locked ? "locked" : ""}`}
              onClick={() => setGi(w.k)}
              title={`GW${w.gw} — ${w.points.toFixed(1)} pts`
                + (chip ? ` · ${chip[1]}` : "")
                + (w.transfers.length ? ` · ${w.transfers.length} transfer${w.transfers.length === 1 ? "" : "s"}` : "")}>
              <span className="tl-marks">
                {chip && <i className="tl-dot chip" />}
                {!!w.transfers.length && <i className="tl-dot tx" />}
                {w.locked && <i className="tl-dot lock" />}
              </span>
              {/* Height carries the projection, so a fixture swing is visible
                  as a shape before any number is read. */}
              <span className="tl-bar" style={{ height: `${h}px` }} />
              <span className="tl-pts">{w.points.toFixed(0)}</span>
              <span className="tl-gw">{w.gw}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
