import React, { useMemo, useState } from "react";
import { DATA, byId, money, gradeTone, playerGrade, playerRating } from "./logic.js";
import {
  CHIPS, HIT_COST, MAX_BANK, UNLIMITED, chipsSpent, emptyPlan, planQuality,
} from "./plan.js";

// The season plan, one gameweek at a time.
//
// The interaction is the point: you LOCK a week, which is a commitment, and the
// consequences of that commitment appear immediately in the numbers above — the
// gameweek bar, the plan score. Planning tools usually let you toggle things in
// a vacuum and tell you the total at the end; this one makes each week cost
// something, because a transfer bank and four-point hits are the whole game.
// One week's transfers: pick who leaves, then who arrives. Candidates are
// filtered to the same position and to what the bank can afford, because a
// suggestion you cannot execute is noise.
function PlanTransfers({ row, setWeek }) {
  const [out, setOut] = useState(null);
  const [q, setQ] = useState("");
  const owned = row.squad.map((i) => byId[i]).filter(Boolean);
  const outP = out != null ? byId[out] : null;

  const candidates = useMemo(() => {
    if (!outP) return [];
    const have = new Set(row.squad);
    const clubs = {};
    for (const i of row.squad) {
      if (i === out) continue;
      const p = byId[i];
      if (p) clubs[p.t] = (clubs[p.t] || 0) + 1;
    }
    const budget = row.inTheBank + outP.c;
    const term = q.trim().toLowerCase();
    return DATA.players
      .filter((p) => p.p === outP.p && !have.has(p.i) && p.c <= budget + 1e-6
        && (clubs[p.t] || 0) < 3
        && (!term || p.n.toLowerCase().includes(term)))
      .sort((a, b) => b.x - a.x)
      .slice(0, 6);
  }, [out, q, row.squad.join(","), row.inTheBank]);

  const add = (inP) => {
    setWeek(row.k, { transfers: [...(row.transfers || []), { out, in: inP.i }] });
    setOut(null); setQ("");
  };
  const drop = (idx) =>
    setWeek(row.k, { transfers: row.transfers.filter((_, j) => j !== idx) });

  return (
    <div className="pt">
      {row.transfers.length > 0 && (
        <ul className="pt-list">
          {row.transfers.map((m, j) => {
            const a = byId[m.out], b = byId[m.in];
            if (!a || !b) return null;
            const d = (playerRating(b, row.k) ?? 0) - (playerRating(a, row.k) ?? 0);
            const v = d >= 18 ? ["up", "Clear upgrade"] : d >= 7 ? ["up", "Modest upgrade"]
              : d > -7 ? ["flat", "Like for like"] : ["down", "Downgrade"];
            return (
              <li key={j} className="pt-row">
                <span className={`pt-g g-${gradeTone(playerGrade(a, row.k))}`}>{playerGrade(a, row.k)}</span>
                <span className="pt-n">{a.n}</span>
                <span className="pt-arrow">→</span>
                <span className={`pt-g g-${gradeTone(playerGrade(b, row.k))}`}>{playerGrade(b, row.k)}</span>
                <span className="pt-n">{b.n}</span>
                <span className={`pt-v ${v[0]}`}>{v[1]}</span>
                <button className="pt-x" onClick={() => drop(j)} aria-label="Remove">×</button>
              </li>
            );
          })}
        </ul>
      )}

      {!outP ? (
        <div className="pt-pick">
          <span className="pt-lab">
            Transfer out
            <i className="pt-hint">tap a shirt on the pitch, or pick here</i>
          </span>
          <div className="pt-owned">
            {owned.map((p) => (
              <button key={p.i} className="pt-own" onClick={() => setOut(p.i)}>
                <em>{p.p}</em>{p.n}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="pt-pick">
          <span className="pt-lab">
            Replacing <b>{outP.n}</b> · £{(row.inTheBank + outP.c).toFixed(1)}m to spend
            <button className="pt-cancel" onClick={() => { setOut(null); setQ(""); }}>Cancel</button>
          </span>
          <input className="pt-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${outP.p === "GK" ? "keepers" : outP.p.toLowerCase() + "s"}`} />
          {candidates.length === 0 && (
            <p className="pt-empty">
              No {outP.p} you can afford and fit under the three-per-club cap.
              Sell someone dearer first, or search a different name.
            </p>
          )}
          {candidates.map((p) => {
            const d = (playerRating(p, row.k) ?? 0) - (playerRating(outP, row.k) ?? 0);
            const v = d >= 18 ? ["up", "Clear upgrade"] : d >= 7 ? ["up", "Modest upgrade"]
              : d > -7 ? ["flat", "Like for like — little to gain"] : ["down", "Downgrade"];
            return (
              <button key={p.i} className="pt-cand" onClick={() => add(p)}>
                <span className={`pt-g g-${gradeTone(playerGrade(p, row.k))}`}>{playerGrade(p, row.k)}</span>
                <span className="pt-n">{p.n}</span>
                <span className="pt-meta">{p.t} · {money(p.c)} · {p.g[row.k].toFixed(1)}</span>
                <span className={`pt-v ${v[0]}`}>{v[1]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PlanBoard({ squad, gi, setGi, plan, setPlan }) {
  const [open, setOpen] = useState(null);
  const p = plan && plan.base?.length ? plan : emptyPlan(squad);
  const q = useMemo(() => planQuality(p), [p]);
  const spent = chipsSpent(p);

  const setWeek = (k, patch) => {
    const next = { ...p, weeks: { ...p.weeks, [k]: { ...(p.weeks[k] || {}), ...patch } } };
    setPlan(next);
  };

  const toggleChip = (k, chip) => {
    const cur = p.weeks[k]?.chip || null;
    if (cur === chip) return setWeek(k, { chip: null });
    // One of each per season. Spending it twice is not a plan, it is a mistake
    // the interface should refuse rather than score.
    if (spent.includes(chip)) return;
    setWeek(k, { chip });
  };

  const w = q.weeks;
  const band = q.score >= 78 ? "good" : q.score >= 55 ? "ok" : "poor";

  return (
    <div className="pb">
      <div className="pb-head">
        <div>
          <b>Season plan</b>
          <span>
            Lock a week to bank its transfer. Chips change what that week scores.
          </span>
        </div>
        <div className={`pb-score ${band}`}>
          {q.score}<em>plan quality</em>
        </div>
      </div>

      <p className="pb-sum">
        {q.gained >= 0.5
          ? <>This plan is <b>{q.gained.toFixed(1)}</b> points ahead of holding your
              squad and playing nothing.</>
          : <>This plan is level with holding your squad and playing nothing.</>}
        {q.chipsLeft > 1 && (
          <> Your chips are worth <b>{q.chipsLeft.toFixed(1)}</b> more in better weeks
            than the ones you picked.</>
        )}
      </p>

      <div className="pb-weeks">
        {w.map((row) => {
          const isOpen = open === row.k;
          const isNow = row.k === gi;
          return (
            <div key={row.k}
              className={`pb-w ${isNow ? "now" : ""} ${row.locked ? "locked" : ""} ${isOpen ? "open" : ""}`}>
              <button className="pb-w-head" onClick={() => { setOpen(isOpen ? null : row.k); setGi(row.k); }}>
                <span className="pb-gw">GW{row.gw}</span>
                <span className="pb-pts">{row.points.toFixed(1)}</span>
                <span className="pb-bank">
                  {row.chip
                    ? <em className={`pb-chip ${row.chip}`}>{CHIPS.find((c) => c[0] === row.chip)[1]}</em>
                    : `${row.bankBefore} FT`}
                </span>
                {row.hits > 0 && <span className="pb-hit">−{row.hits}</span>}
                {row.locked && <span className="pb-lock" aria-label="Locked">✓</span>}
              </button>

              {isOpen && (
                <div className="pb-w-body">
                  <div className="pb-chips">
                    {CHIPS.map(([k2, label, why]) => {
                      const used = spent.includes(k2) && row.chip !== k2;
                      return (
                        <button key={k2} title={why} disabled={used}
                          className={`pb-chip-btn ${row.chip === k2 ? "on" : ""}`}
                          onClick={() => toggleChip(row.k, k2)}>
                          {label}
                          {used && <i>played</i>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="pb-money">
                    <span>£{row.inTheBank.toFixed(1)}m in the bank</span>
                    <span>{row.used} made · {row.paid > 0 ? `${row.paid} at −${HIT_COST}` : "all free"}</span>
                  </div>
                  <p className="pb-why">
                    {row.chip
                      ? CHIPS.find((c) => c[0] === row.chip)[2]
                      : UNLIMITED.has(row.chip)
                        ? ""
                        : `${row.bankBefore} free transfer${row.bankBefore === 1 ? "" : "s"} banked. `
                          + `A ${row.bankBefore + 1}th this week costs ${HIT_COST} points.`}
                  </p>
                  {/* Per-week transfers. The bank, the hit and the grade step
                      all update as soon as a move is added, because the only
                      way to judge "is this worth a hit" is to see the cost at
                      the moment you make it. */}
                  <PlanTransfers row={row} setWeek={setWeek} />

                  <div className="pb-acts">
                    <button className={`pb-lock-btn ${row.locked ? "on" : ""}`}
                      onClick={() => setWeek(row.k, { locked: !row.locked })}>
                      {row.locked
                        ? <>✓ GW{row.gw} locked — tap to reopen</>
                        : <>Lock GW{row.gw}</>}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="pb-foot">
        Transfers bank up to {MAX_BANK}. A wildcard or free hit makes that week
        unlimited — and a free hit hands the squad back afterwards, which is the
        rule most plans get wrong.
      </p>
    </div>
  );
}
