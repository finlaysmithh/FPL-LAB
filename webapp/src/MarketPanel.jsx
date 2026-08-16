import React, { useMemo, useState } from "react";
import {
  BUDGET, DATA, MIN_MINUTES, POS_ORDER, QUOTA, byId, clubCounts, isGated,
  money, squadCost, gradeTone, playerGrade, playerRating,
} from "./logic.js";
import { TEAM_NAMES } from "./kits.js";
import { FixtureStrip, Jersey, NextFixture, availInfo } from "./components.jsx";

const SORTS = [
  ["x", "Total points"],
  ["v", "Per £m"],
  ["gw", "This GW"],
  ["c", "Cheapest"],
  ["o", "Differential"],
];
const CAPS = [null, 4.5, 5.0, 5.5, 6.5, 8.0, 11.0];
const TEAMS = Object.keys(TEAM_NAMES).sort();

/**
 * The transfer market.
 *
 * Two things make this different from a plain filtered list. First it stays on
 * screen next to the pitch on desktop, so you never lose sight of the squad you
 * are changing. Second, when you are replacing someone every row is scored
 * *against him* — the points and the money you gain or give up by making that
 * exact swap — because that difference, not the absolute total, is the decision
 * you are actually making.
 */
export function MarketPanel({ squad, gi, out, pos, setPos, onSwapIn, onCancel, dense }) {
  const [sort, setSort] = useState("x");
  const [q, setQ] = useState("");
  const [maxC, setMaxC] = useState(null);
  const [team, setTeam] = useState("");
  // Squads usually sit near the £100m ceiling, so an unfiltered list is mostly
  // players you cannot buy. Default to what is actually reachable and let the
  // toggle open it up when you want to plan a downgrade elsewhere.
  const [affordOnly, setAffordOnly] = useState(true);

  const outP = out != null ? byId[out] : null;
  const others = squad.filter((i) => i !== out);
  const left = BUDGET - squadCost(others);
  const cc = clubCounts(others);

  const list = useMemo(() => {
    let l = DATA.players.filter((p) => p.p === pos && !others.includes(p.i));
    if (maxC) l = l.filter((p) => p.c <= maxC);
    if (team) l = l.filter((p) => p.t === team);
    // Only meaningful while replacing someone: with a full squad and no player
    // on the way out the budget is just the bank, which would empty the list.
    if (affordOnly && outP) l = l.filter((p) => p.c <= left + 1e-6 || p.i === out);
    const s = q.trim().toLowerCase();
    if (s) l = l.filter((p) => p.n.toLowerCase().includes(s) || p.t.toLowerCase().includes(s));
    return [...l].sort((a, b) =>
      sort === "x" ? b.x - a.x
        : sort === "gw" ? b.g[gi] - a.g[gi]
        : sort === "c" ? a.c - b.c
        : sort === "v" ? b.x / b.c - a.x / a.c
        : a.o - b.o);
  }, [pos, others.join(","), maxC, team, affordOnly, left, q, sort, gi, out, outP]);

  // With no one on the way out you can only add into a position that still has
  // a free slot.
  const roomInPos = squad.map((i) => byId[i]).filter((p) => p?.p === pos).length < QUOTA[pos];

  return (
    <div className={`market ${dense ? "dense" : ""}`}>
      <div className="mk-head">
        <div className="mk-tabs" role="tablist" aria-label="Position">
          {POS_ORDER.map((k) => (
            <button key={k} role="tab" aria-selected={pos === k}
              className={`mk-tab ${pos === k ? "on" : ""}`}
              onClick={() => setPos(k)}>
              {k}
            </button>
          ))}
        </div>

        {outP ? (
          <div className="mk-out">
            <Jersey team={outP.t} size={26} />
            <div className="mk-out-body">
              <div className="mk-out-label">Replacing</div>
              <div className="mk-out-name">
                <span className={`mk-g g-${gradeTone(playerGrade(outP, gi))}`}>
                  {playerGrade(outP, gi)}
                </span>
                {outP.n} <span>{outP.t} · {money(outP.c)} · {outP.x.toFixed(1)} pts</span>
              </div>
            </div>
            <button className="mk-cancel" onClick={onCancel}>Keep him</button>
          </div>
        ) : (
          <p className="mk-hint">
            Pick a player to add. To replace someone instead, close this and tap
            him on the pitch.
          </p>
        )}

        <input className="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${pos === "GK" ? "keepers" : pos.toLowerCase() + "s"} or clubs`} />

        <div className="chip-row">
          {SORTS.map(([k, label]) => (
            <button key={k} onClick={() => setSort(k)}
              className={`chip ${sort === k ? "on" : ""}`}>
              {k === "gw" ? `GW${DATA.gws[gi]}` : label}
            </button>
          ))}
        </div>

        <div className="chip-row">
          <select className="mk-select" value={team} onChange={(e) => setTeam(e.target.value)}
            aria-label="Filter by club">
            <option value="">All clubs</option>
            {TEAMS.map((t) => <option key={t} value={t}>{TEAM_NAMES[t]}</option>)}
          </select>
          <select className="mk-select" value={maxC ?? ""} aria-label="Maximum price"
            onChange={(e) => setMaxC(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Any price</option>
            {CAPS.filter(Boolean).map((v) => (
              <option key={v} value={v}>Up to {v.toFixed(1)}</option>
            ))}
          </select>
        </div>

        <div className="mk-foot">
          <span className="mk-count">
            {list.length} shown{outP ? ` · ${money(left)} to spend` : ""}
          </span>
          <div className="mk-toggles">
            {outP && (
              <label className="mk-toggle">
                <input type="checkbox" checked={affordOnly}
                  onChange={(e) => setAffordOnly(e.target.checked)} />
                In budget
              </label>
            )}
          </div>
        </div>
      </div>

      <div className="mk-list">
        {list.length === 0 && (
          <p className="mk-empty">
            {affordOnly && outP
              ? `Nothing in this position costs ${money(left)} or less. Untick “In budget” to see what a downgrade elsewhere would buy you.`
              : "No player matches these filters. Widen the price or clear the club."}
          </p>
        )}
        {list.map((p) => {
          const afford = p.c <= left + 1e-6;
          const clubOk = (cc[p.t] || 0) < 3;
          const ok = afford && clubOk && p.i !== out && (outP ? true : roomInPos);
          const dPts = outP ? p.x - outP.x : null;
          const dCash = outP ? outP.c - p.c : null;
          const av = availInfo(p);
          return (
            <div key={p.i} className={`mk-row ${p.i === out ? "is-out" : ""} ${ok ? "" : "blocked"}`}>
              <Jersey team={p.t} size={26} />
              <div className="mk-info">
                <div className="mk-name">
                  {/* The candidate's grade, next to the outgoing player's, so
                      the swap reads as a comparison. */}
                  <span className={`mk-g g-${gradeTone(playerGrade(p, gi))}`}>
                    {playerGrade(p, gi)}
                  </span>
                  {p.n}
                  {p.pk === 1 && <span className="tag pen-tag">PEN</span>}
                  {av && <span className={`tag ${av.tone}`} title={p.nw}>{av.label}</span>}
                  {p.pr === 1 && (
                    <span className="tag proxy"
                      title="No usable Premier League record — rates estimated from price">
                      price est.
                    </span>
                  )}
                  {isGated(p) && (
                    <span className="tag low"
                      title={`Projected ${p.xm} minutes a game — under the ${MIN_MINUTES}-minute bar`}>
                      low mins
                    </span>
                  )}
                </div>
                <div className="mk-meta">
                  {p.t} · {money(p.c)} · {p.x.toFixed(1)} pts · {(p.x / p.c).toFixed(1)} per £m
                  {p.xm != null && ` · ${Math.round(p.xm)}′`}
                </div>
                {outP && p.i !== out && (() => {
                  // Grade step, named. Swapping an A+ for another A+ is a
                  // transfer spent to stand still, and the points delta alone
                  // does not say so — it can read +0.3 and look like progress.
                  const rIn = playerRating(p, gi) ?? 0;
                  const rOut = playerRating(outP, gi) ?? 0;
                  const d = rIn - rOut;
                  const v = d >= 18 ? ["up", "Clear upgrade"]
                    : d >= 7 ? ["up", "Modest upgrade"]
                      : d > -7 ? ["flat", "Like for like — little to gain"]
                        : ["down", "Downgrade"];
                  return (
                    <div className={`mk-step ${v[0]}`}>
                      {playerGrade(outP, gi)} → {playerGrade(p, gi)} · {v[1]}
                    </div>
                  );
                })()}
                <div className="mk-fx">
                  <NextFixture team={p.t} gi={gi} compact />
                  <FixtureStrip team={p.t} gi={gi} />
                </div>
                {!ok && p.i !== out && (
                  <div className="mk-block">
                    {!outP && !roomInPos
                      ? `All ${QUOTA[pos]} ${pos} slots are filled — tap one on the pitch to swap him out`
                      : !afford
                        ? `£${(p.c - left).toFixed(1)}m short — sell someone dearer first`
                        : `You already have three ${p.t} players`}
                  </div>
                )}
              </div>

              <div className="mk-action">
                {outP && p.i !== out && (
                  <div className="mk-delta">
                    <span className={dPts >= 0 ? "up" : "down"}>
                      {dPts >= 0 ? "+" : ""}{dPts.toFixed(1)} pts
                    </span>
                    <span className={dCash >= 0 ? "cash-up" : "cash-down"}>
                      {dCash >= 0 ? "+" : "−"}£{Math.abs(dCash).toFixed(1)}m
                    </span>
                  </div>
                )}
                {p.i === out ? (
                  <span className="mk-current">In your squad</span>
                ) : (
                  <button className="mk-add" disabled={!ok}
                    onClick={() => onSwapIn(p.i)}
                    aria-label={outP
                      ? `Swap ${outP.n} out for ${p.n}`
                      : `Add ${p.n} to your squad`}>
                    {outP ? "Swap in" : "Add"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
