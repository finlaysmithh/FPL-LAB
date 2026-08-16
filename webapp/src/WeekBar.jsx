import React, { useMemo, useState } from "react";
import { DATA, byId, money, gradeTone, playerGrade, playerRating } from "./logic.js";
import { CHIPS, MAX_BANK, UNLIMITED, chipsSpent, emptyPlan, resolvePlan } from "./plan.js";
import { LOOKAHEAD, weekAdvice } from "./advice.js";
import { weekScore } from "./solver.js";

// Locking and chips, on the team itself.
//
// This replaced a separate nineteen-row planning table. Planning is something
// you do TO the squad in front of you — you look at the eleven, decide it is
// right, and commit the week. A table elsewhere made you hold the shape in your
// head while editing numbers somewhere else.
//
// Locking a week is what makes the plan a sequence rather than a set of
// independent guesses: once GW1 is committed, GW2 starts from that squad and
// spends that week's transfer, and the bank carries forward.
// Who leaves, who arrives, this week.
function WeekTransfers({ row, set }) {
  const [out, setOut] = useState(null);
  const [q, setQ] = useState("");
  const outP = out != null ? byId[out] : null;
  const moves = row.transfers || [];

  const cands = useMemo(() => {
    if (!outP) return [];
    const have = new Set(row.squad);
    const clubs = {};
    for (const i of row.squad) {
      if (i === out) continue;
      const pl = byId[i];
      if (pl) clubs[pl.t] = (clubs[pl.t] || 0) + 1;
    }
    const budget = row.inTheBank + outP.c;
    const term = q.trim().toLowerCase();
    return DATA.players
      .filter((pl) => pl.p === outP.p && !have.has(pl.i) && pl.c <= budget + 1e-6
        && (clubs[pl.t] || 0) < 3 && (!term || pl.n.toLowerCase().includes(term)))
      .sort((a, b) => b.x - a.x).slice(0, 5);
  }, [out, q, row.squad.join(","), row.inTheBank]);

  const step = (a, b) => {
    const d = (playerRating(b, row.k) ?? 0) - (playerRating(a, row.k) ?? 0);
    return d >= 18 ? ["up", "Clear upgrade"] : d >= 7 ? ["up", "Modest upgrade"]
      : d > -7 ? ["flat", "Like for like"] : ["down", "Downgrade"];
  };

  return (
    <div className="wt">
      {moves.map((m, j) => {
        const a = byId[m.out], b = byId[m.in];
        if (!a || !b) return null;
        const v = step(a, b);
        return (
          <div key={j} className="wt-done">
            <span className={`wt-g g-${gradeTone(playerGrade(a, row.k))}`}>{playerGrade(a, row.k)}</span>
            <b>{a.n}</b><span className="wt-ar">→</span>
            <span className={`wt-g g-${gradeTone(playerGrade(b, row.k))}`}>{playerGrade(b, row.k)}</span>
            <b>{b.n}</b>
            <span className={`wt-v ${v[0]}`}>{v[1]}</span>
            <button className="wt-x" aria-label="Undo"
              onClick={() => set({ transfers: moves.filter((_, i) => i !== j) })}>×</button>
          </div>
        );
      })}

      {!outP ? (
        <div className="wt-pick">
          {row.squad.map((i) => byId[i]).filter(Boolean).map((pl) => (
            <button key={pl.i} className="wt-own" onClick={() => setOut(pl.i)}>
              <em>{pl.p}</em>{pl.n}
            </button>
          ))}
        </div>
      ) : (
        <div className="wt-search">
          <div className="wt-lab">
            Replacing <b>{outP.n}</b> · £{(row.inTheBank + outP.c).toFixed(1)}m to spend
            <button onClick={() => { setOut(null); setQ(""); }}>Cancel</button>
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${outP.p === "GK" ? "keepers" : outP.p.toLowerCase() + "s"}`} />
          {cands.length === 0 && (
            <p className="wt-none">
              Nothing you can afford at {outP.p} inside the three-per-club cap.
            </p>
          )}
          {cands.map((pl) => {
            const v = step(outP, pl);
            return (
              <button key={pl.i} className="wt-cand"
                onClick={() => { set({ transfers: [...moves, { out, in: pl.i }] }); setOut(null); setQ(""); }}>
                <span className={`wt-g g-${gradeTone(playerGrade(pl, row.k))}`}>{playerGrade(pl, row.k)}</span>
                <b>{pl.n}</b>
                <span className="wt-meta">{pl.t} · {money(pl.c)}</span>
                <span className={`wt-v ${v[0]}`}>{v[1]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Every week you have committed to, in order.
function PlanSummary({ weeks, gi }) {
  const done = weeks.filter((w) => w.locked || w.chip || w.transfers.length);
  if (!done.length) return null;
  const total = weeks.reduce((t, w) => t + w.points, 0);
  return (
    <div className="ps">
      <div className="ps-k">
        Your plan
        <em>{done.length} week{done.length === 1 ? "" : "s"} committed · {total.toFixed(0)} pts</em>
      </div>
      {done.map((w) => (
        <div key={w.k} className={`ps-row ${w.k === gi ? "now" : ""}`}>
          <span className="ps-gw">GW{w.gw}</span>
          <span className="ps-body">
            {w.chip && (
              <b className="ps-chip">
                {CHIPS.find((c) => c[0] === w.chip)[1]} used
              </b>
            )}
            {w.transfers.map((m, j) => {
              const a = byId[m.out], b = byId[m.in];
              if (!a || !b) return null;
              return (
                <span key={j} className="ps-tx">{a.n} → {b.n}</span>
              );
            })}
            {!w.chip && !w.transfers.length && <span className="ps-hold">Held, transfer rolled</span>}
          </span>
          {w.paid > 0 && <span className="ps-hit">−{w.paid * 4}</span>}
          {w.locked && <span className="ps-lock">✓</span>}
        </div>
      ))}
    </div>
  );
}

export function WeekBar({ gi, setGi, plan, setPlan, squad }) {
  const p = plan && plan.base?.length ? plan : emptyPlan(squad);
  const weeks = resolvePlan(p, DATA.gws.length);
  const row = weeks[gi];
  if (!row) return null;

  const spent = chipsSpent(p);
  const set = (patch) =>
    setPlan({ ...p, weeks: { ...p.weeks, [gi]: { ...(p.weeks[gi] || {}), ...patch } } });

  const toggleChip = (chip) => {
    const cur = p.weeks[gi]?.chip || null;
    if (cur === chip) return set({ chip: null });
    if (spent.includes(chip)) return;          // one of each per season
    set({ chip });
  };

  const locked = row.locked;
  const chipNow = row.chip;

  return (
    <div className={`wb ${locked ? "locked" : ""}`}>
      {/* The verdict, before the controls. A planner that opens with switches
          makes you work out what to do; this one answers first and lets you
          disagree. */}
      {(() => {
        const chipDef = row.chip && CHIPS.find((c) => c[0] === row.chip);
        const a = weekAdvice(row, {
          chipName: chipDef && chipDef[1], chipWhy: chipDef && chipDef[2],
        });
        return (
          <>
            <div className={`wv ${a.tone}`}>
              <span className="wv-tag">{a.verdict}</span>
              <div className="wv-body">
                <b>{a.headline}</b>
                <span>{a.why}</span>
              </div>
            </div>
            {a.moves.length > 0 && a.verdict !== "CHIP" && (
              <div className="wo">
                <div className="wo-k">
                  Best moves this week
                  <em>scored against the best one available</em>
                </div>
                {a.moves.slice(0, 4).map((m, j) => (
                  <button key={j} className="wo-row"
                    onClick={() => set({ transfers: [...(row.transfers || []), { out: m.out.i, in: m.in.i }] })}>
                    <span className="wo-score" style={{
                      background: `conic-gradient(var(--green) ${m.score * 3.6}deg, rgba(255,255,255,.08) 0)`,
                    }}><i>{m.score}</i></span>
                    <span className="wo-names">
                      <b>{m.out.n} → {m.in.n}</b>
                      <em>{m.label} · +{m.gain.toFixed(1)} over {LOOKAHEAD} weeks
                        {m.cash > 0 && ` · £${m.cash.toFixed(1)}m left`}</em>
                    </span>
                    {/* A move can win the window and lose THIS week — that is
                        the point of planning ahead — so the sign has to be
                        honest rather than always "+". */}
                    <span className={`wo-now ${m.now < 0 ? "neg" : ""}`}>
                      {m.now >= 0 ? "+" : "−"}{Math.abs(m.now).toFixed(1)}
                      <i>GW{row.gw}</i>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        );
      })()}

      <div className="wb-top">
        <button className={`wb-lock ${locked ? "on" : ""}`}
          onClick={() => set({ locked: !locked })}>
          {locked ? `✓ GW${row.gw} locked` : `Lock GW${row.gw}`}
        </button>
        <div className="wb-facts">
          <span><b>{row.bankBefore}</b> free {row.bankBefore === 1 ? "transfer" : "transfers"}</span>
          <span><b>{row.used}</b> used{row.paid > 0 && <em> · −{row.paid * 4}</em>}</span>
          <span>£{row.inTheBank.toFixed(1)}m bank</span>
        </div>
      </div>

      <div className="wb-chips">
        {CHIPS.map(([k, label, why]) => {
          const used = spent.includes(k) && chipNow !== k;
          return (
            <button key={k} title={why} disabled={used}
              className={`wb-chip ${chipNow === k ? "on" : ""}`}
              onClick={() => toggleChip(k)}>
              {label}{used && <i>played</i>}
            </button>
          );
        })}
      </div>

      {/* Transfers for THIS week, staged against the squad as it stands after
          every earlier week's moves — which is the only squad the question
          makes sense against. */}
      <WeekTransfers row={row} set={set} />

      {/* CHIP TIMING LIVES IN ONE PLACE — the plan bar at the top of the page.
          It used to be re-derived here too, by a different model (`chipStrategy`
          in advice.js) against a different target, and the two disagreed: the
          plan bar would say "hold your wildcard" while this card said "PLAY,
          best window GW2" to someone who had just imported the optimal squad.
          Two chip models cannot both be right, and a user has no way to tell
          which one the app believes. This is the per-week TRANSFER planner now;
          chips are decided above. */}
      {/* The plan so far, in one line per committed week. Without it the plan
          only exists a week at a time and you cannot see whether the chips are
          spread sensibly or stacked on top of each other. */}
      <PlanSummary weeks={weeks} gi={gi} />

      <p className="wb-why">
        {chipNow
          ? CHIPS.find((c) => c[0] === chipNow)[2]
          : locked
            ? `Committed. GW${DATA.gws[gi + 1] || row.gw} starts from this squad with `
              + `${Math.min(MAX_BANK, row.bankBefore - Math.min(row.bankBefore, row.used) + 1)} free.`
            : `Transfers bank to ${MAX_BANK}. A move beyond the bank costs 4 points.`}
      </p>
    </div>
  );
}
