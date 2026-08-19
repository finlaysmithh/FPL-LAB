import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BUDGET, DATA, OPTIMAL, byId, gradeFor, gradeTone, isGated, money,
} from "./logic.js";
import {
  chipAdvice, chipWeeks, freeHitWeeks, optimise, solveCached, warmWindows,
  squadRating, weekScore, wildcardWeeks, windowRobustness,
} from "./solver.js";
import { CaptainBar, GwPicker, Tiles } from "./components.jsx";
import { Pitch } from "./Pitch.jsx";

// Each strategy is a different question, so each gets its own objective rather
// than one squad relabelled four ways. The distinction that matters most:
// Free Hit is scored on ONE week because you hand the squad back afterwards,
// while every other chip is played on a squad you keep — so those are scored
// over the run of weeks that follow.
//
// The four options are chips, and the horizon is a separate axis, because
// "Wildcard" and "no chip, held for six weeks" are the SAME optimisation — the
// best squad to hold from here — and only differ in whether you were allowed
// to build it for free. Presenting them as two strategies implied a difference
// in the answer that does not exist. So: pick the chip, pick how long you are
// planning to keep the squad, and Hold is the honest default.
const STRATEGIES = [
  {
    key: "hold",
    name: "No chip",
    tag: "Best squad to keep",
    blurb: "The squad to hold from here with no chip played — the honest baseline, and the same answer a Wildcard gives you, since a wildcard is just permission to build this squad for free.",
    weeks: (gi, span, mode) => wildcardWeeks(gi, span, mode),
  },
  {
    key: "freehit",
    name: "Free Hit",
    tag: "One week only",
    blurb: "The perfect fifteen for a single gameweek. You hand the squad back afterwards, so nothing beyond this week counts — which is why it buys players you would never keep.",
    weeks: (gi) => freeHitWeeks(gi),
    fixedSpan: 1,
  },
  {
    key: "bb",
    name: "Bench Boost",
    tag: "Bench scores too",
    blurb: "Built knowing your four substitutes score in the chip week. A bench that pays changes what a bench is for, so money moves off the starting eleven and into the last four slots.",
    weeks: (gi, span, mode) => chipWeeks(gi, span, gi, "bb", mode),
  },
  {
    key: "tc",
    name: "Triple Captain",
    tag: "Armband pays 3×",
    blurb: "Built knowing the armband pays three times rather than twice in the chip week, which is worth overpaying at the very top of the squad for.",
    weeks: (gi, span, mode) => chipWeeks(gi, span, gi, "tc", mode),
  },
];

// How long you actually intend to keep this squad. It changes the answer a
// lot: a one-week view buys the best fixtures this week, a ten-week view buys
// players who survive a fixture swing. Any week between the two is a real
// question, so it is a slider rather than three favourite answers.
const SPAN_MIN = 1;
const SPAN_MAX = 10;

// What the number you have chosen actually buys you, said in one line. The
// horizon is the single most consequential control on this page and the least
// self-explanatory, so it explains itself as you move it.
function spanNote(n) {
  if (n === 1) return "One week only — this buys the best fixtures going and nothing else. Same answer as a Free Hit, minus the chip.";
  if (n <= 3) return "A short hold. Form and fixtures still dominate; a player two rough weeks away is still worth owning.";
  if (n <= 6) return "The usual planning window. Long enough that a fixture swing shows up, short enough to stay honest.";
  if (n <= 8) return "A long hold. Weight moves toward nailed minutes and away from anyone riding a soft run.";
  return "Half a season. Only players who survive every fixture swing survive this — and nobody really keeps a squad this long.";
}

const STRAT_ICON = {
  hold: <><path d="M4 7h16M4 12h16M4 17h10" /></>,
  freehit: <path d="M4 12h6l2-6 2 12 2-6h4" />,
  bb: <><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M6 10h12M8 6h8" /></>,
  tc: <><path d="M12 3l2.6 5.6 6.4.9-4.6 4.4 1.1 6.1L12 17l-5.5 3 1.1-6.1L3 9.5l6.4-.9Z" /></>,
};

function StratIcon({ k }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {STRAT_ICON[k]}
    </svg>
  );
}

// ---- constraint pickers ---------------------------------------------------
// "Show me the best squad that HAS to contain these players" — and its mirror,
// "the best squad WITHOUT this one". The whole point is that both are
// constraints, not preferences — so the panel also reports what the constraint
// costs, which is the number people actually want and never get.
//
// One component, two modes, because the two panels are the same control with
// the sign flipped: search, chips, the same legality rules. `taken` is every
// player already claimed by EITHER list — a player locked in and banned at the
// same time is a contradiction the solver would only report as infeasible, so
// the picker refuses to construct it in the first place.
function ConstraintPicker({ mode, ids, setIds, taken }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const ban = mode === "ban";

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return DATA.players
      .filter((p) => p.n.toLowerCase().includes(term) && !taken.includes(p.i))
      .sort((a, b) => b.x - a.x)
      .slice(0, 7);
  }, [q, taken]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const add = (p) => { setIds([...ids, p.i]); setQ(""); setOpen(false); };

  return (
    <div className={`lockbox ${ban ? "ban" : ""}`} ref={boxRef}>
      <div className="lockbox-head">
        <div>
          <b>{ban ? "Don't include" : "Build around"}</b>
          <span>{ban ? "Players the squad must leave out" : "Players the squad must contain"}</span>
        </div>
        {ids.length > 0 && (
          <button className="lock-clear" onClick={() => setIds([])}>Clear</button>
        )}
      </div>

      {ids.length > 0 && (
        <div className="lock-chips">
          {ids.map((i) => {
            const p = byId[i];
            if (!p) return null;
            return (
              <span key={i} className={`lock-chip ${p.p} ${ban ? "ban" : ""}`}>
                <em>{p.p}</em>
                {p.n}
                <i>{money(p.c)}</i>
                <button onClick={() => setIds(ids.filter((x) => x !== i))}
                  aria-label={`Remove ${p.n}`}>×</button>
              </span>
            );
          })}
        </div>
      )}

      <div className="lock-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input value={q}
          placeholder={ban ? "Exclude a player — try Salah" : "Add a player — try Haaland"}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)} />
      </div>

      {open && matches.length > 0 && (
        <ul className="lock-results">
          {matches.map((p) => (
            // Locking a sub-25-minute player is refused — the optimiser would
            // never pick him, so the lock could only mislead. Banning one is
            // allowed but flagged: it is harmless, because he was never
            // getting in anyway.
            <li key={p.i}>
              <button onClick={() => add(p)} disabled={!ban && isGated(p)}>
                <span className={`lock-pos ${p.p}`}>{p.p}</span>
                <span className="lock-name">{p.n}</span>
                <span className="lock-team">{p.t}</span>
                <span className="lock-price">{money(p.c)}</span>
                <span className="lock-xp">{p.x.toFixed(0)} pts</span>
                {isGated(p) && <span className="lock-gate">barely plays</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- robustness -----------------------------------------------------------
// "Is this squad right regardless of my plan, or a bet on my plan?" A 13-core
// squad is robust; a 6-core squad is a specific wager, and a user about to
// spend a wildcard deserves to know which one they are looking at.
function Robustness({ ids, weightMode }) {
  const [rob, setRob] = useState(null);

  // The cache fills in the background, so this recomputes on a timer until the
  // picture is complete. A partial answer is shown WITH its coverage rather
  // than withheld — most of the signal is there after a dozen windows.
  // An interval rather than a self-scheduling chain: a chain stops permanently
  // if any single tick throws or is interrupted, and the symptom is a coverage
  // count frozen at whatever it reached — which looks like a settled answer.
  useEffect(() => {
    const read = () => setRob(windowRobustness(10, weightMode));
    read();
    const id = setInterval(() => {
      const r = windowRobustness(10, weightMode);
      setRob(r);
      if (r.solved >= r.total) clearInterval(id);
    }, 700);
    return () => clearInterval(id);
  }, [weightMode]);

  if (!rob || !rob.solved) return null;
  const inSquad = new Set(ids);
  const mine = rob.players.filter((p) => inSquad.has(p.id));
  if (!mine.length) return null;

  const nCore = mine.filter((p) => p.band === "core").length;
  const verdict = nCore >= 12
    ? "Robust. Almost all of this squad is optimal whatever window you plan for."
    : nCore >= 8
      ? "Mixed. A solid core, with several players who depend on your window being right."
      : "A specific bet. Most of this squad is optimal only for the window you have selected — worth knowing before you spend a wildcard on it.";

  const LABEL = {
    core: "Core", situational: "Situational", window: "Window-specific",
  };

  return (
    <div className="robust">
      <div className="robust-head">
        <div>
          <b>How much of this is a bet?</b>
          <span>
            {nCore} of {mine.length} core
            {rob.solved < rob.total
              ? ` · ${rob.solved}/${rob.total} windows`
              : ` · all ${rob.total} windows`}
          </span>
        </div>
      </div>
      <p className="robust-verdict">{verdict}</p>
      <p className="robust-fine">
        Swept with the fast solver, which finds the same squad members but not
        always the same last point or two. The window you have selected above is
        solved exactly.
      </p>
      <ul className="robust-list">
        {mine.map((p) => {
          const pl = byId[p.id];
          if (!pl) return null;
          return (
            <li key={p.id} className={`robust-row ${p.band}`}>
              <span className={`robust-pos ${pl.p}`}>{pl.p}</span>
              <span className="robust-name">{pl.n}</span>
              <span className="robust-bar" aria-hidden="true">
                <i style={{ width: `${Math.round(p.share * 100)}%` }} />
              </span>
              <span className="robust-share">{Math.round(p.share * 100)}%</span>
              <span className="robust-band">
                {LABEL[p.band]}
                {p.band === "window" && ` · GW${p.from}–${p.to}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- rating strip ---------------------------------------------------------
// A points total answers "how many", not "is this good". 88 points means
// nothing until you know the ceiling is 95 and the template manager gets 78.
// Anchored at 50 = the most-owned legal fifteen, 100 = the optimal squad under
// the same budget. Measured spread across a sample of built squads is 92
// points, so the scale is not compressed into the high nineties.
function RatingStrip({ squad, gis, chipOpts }) {
  const rows = gis.map((k) => {
    const ceiling = OPTIMAL[String(DATA.gws[k])]?.xp ?? null;
    const r = squadRating(squad, k, ceiling, chipOpts);
    return { k, gw: DATA.gws[k], ...r };
  }).filter((r) => r.rating != null);
  if (!rows.length) return null;
  const mean = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  const meanPts = rows.reduce((s, r) => s + r.pts, 0) / rows.length;

  return (
    <div className="rating">
      <div className="rating-head">
        <div>
          <b>Squad rating</b>
          <span>A+ = the best squad your budget can buy · C = the template manager</span>
        </div>
        <div className={`rating-mean g-${gradeTone(gradeFor(mean))}`}>
          {gradeFor(mean)}
          <em>{meanPts.toFixed(1)} pts/gw · {Math.round(mean)}/100</em>
        </div>
      </div>
      <div className="rating-strip">
        {rows.map((r) => (
          <div key={r.k} className="rating-cell"
            title={`GW${r.gw}: ${r.pts.toFixed(1)} pts · template ${r.field.toFixed(1)} · best ${r.ceiling.toFixed(1)}`}>
            <span className="rating-bar" aria-hidden="true">
              <i style={{ height: `${Math.max(3, r.rating)}%` }} />
            </span>
            <span className={`rating-n g-${gradeTone(gradeFor(r.rating))}`}>
              {gradeFor(r.rating)}
            </span>
            <span className="rating-gw">{r.gw}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OptimalTab({ gi, setGi, onUseSquad }) {
  const [stratKey, setStratKey] = useState("hold");
  // The window is a START and an END, defaulting to GW1–5. `endGi` is an index
  // into DATA.gws like `gi`, so both handles speak the same units.
  const [endGi, setEndGi] = useState(Math.min(4, DATA.gws.length - 1));
  const [weighting, setWeighting] = useState("decay");
  const [locks, setLocks] = useState([]);
  const [bans, setBans] = useState([]);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(true);

  const strat = STRATEGIES.find((s) => s.key === stratKey);
  // A chip is a commitment by definition — you are playing it in this window
  // and will not transfer out of it — so the weighting is forced to flat and
  // the control is disabled rather than silently ignored.
  const chipLocked = stratKey !== "hold";
  const weightMode = chipLocked ? "flat" : weighting;
  const activeSpan = strat.fixedSpan ?? (endGi - gi + 1);

  // Solving is 0.5–0.7s of straight-line JS, which would jank the click that
  // started it. Defer a frame, show the state, then compute.
  // Two tiers, so the window control can be dragged.
  //
  // A provisional answer renders on the next frame — capped search, ~90ms —
  // and the exact one replaces it 300ms after the handle stops moving. Both
  // read through the same cache, so dragging back over a window already solved
  // is instant and skips straight to the exact result.
  //
  // The provisional squad is marked in the UI. A number that is about to change
  // must never look like a number that has settled.
  useEffect(() => {
    const weeks = strat.weeks(gi, activeSpan, weightMode);
    const opts = { lockIds: locks, banIds: bans };
    let alive = true;

    const run = (tier) => {
      const t0 = performance.now();
      const locked = solveCached(weeks, opts, tier);
      // The unconstrained answer is solved too, purely so the panel can say
      // what the locks and exclusions cost — but only at the exact tier, since
      // it costs a second search and nothing reads it mid-drag.
      const free = (locks.length || bans.length) && tier === "exact"
        ? solveCached(weeks, {}, "exact") : locked;
      const advice = locked.feasible && tier === "exact"
        ? chipAdvice(locked.squad, gi, Math.max(activeSpan, 6), OPTIMAL)
        : null;
      if (!alive) return;
      setRes({ locked, free, advice, tier,
               ms: Math.round(performance.now() - t0), weeks });
      setBusy(false);
    };

    setBusy(true);
    const quick = setTimeout(() => run("provisional"), 16);
    const exact = setTimeout(() => run("exact"), 300);
    return () => { alive = false; clearTimeout(quick); clearTimeout(exact); };
  }, [stratKey, gi, activeSpan, weightMode, locks.join(","), bans.join(",")]);

  // Warm the cache for the windows in GW1-10 during idle time, so a drag that
  // arrives later lands on a hit rather than a solve. Cancelled on unmount.
  useEffect(() => warmWindows(10, weightMode), [weightMode]);

  const r = res?.locked;
  const ok = r?.feasible;
  const ids = ok ? r.ids : [];
  const lockCost = ok && res.free?.feasible ? res.free.pts - r.pts : 0;

  // Headline number: what this squad scores in the week the chip is played,
  // under that chip's real scoring rule.
  const thisWeek = ok
    ? weekScore(r.squad, gi, { bb: stratKey === "bb", tc: stratKey === "tc" })
    : null;

  // Unweighted points across the chosen window, and the per-gameweek rate that
  // is the honest headline. The solver's own `r.pts` is WEIGHTED, so dividing
  // it by the week count would report a discounted number as if it were a
  // real average — a squad on a decayed six-week window would look worse than
  // the same squad on a flat three-week one purely from the weighting.
  const windowPts = ok
    ? (res.weeks || []).reduce(
      (s, wk) => s + weekScore(r.squad, wk.k, wk).pts, 0)
    : 0;
  const perGw = ok && (res.weeks || []).length
    ? windowPts / res.weeks.length
    : 0;

  // Every strategy is measured against the same yardstick — the MILP-proven
  // single-week optimum for this gameweek — so the four are comparable.
  const ceiling = OPTIMAL[String(DATA.gws[gi])]?.xp ?? null;

  return (
    <div className="page opt-page">
      <div className="eyebrow">Optimiser</div>
      <h1 className="opt-title">
        Build the perfect fifteen<span className="dot">.</span>
      </h1>
      <p className="opt-lede">
        Pick the strategy you are actually playing. Each one is a different
        question, so each gets its own answer — solved live, on your locks.
      </p>

      <div className="strat-grid" role="tablist" aria-label="Chip strategy">
        {STRATEGIES.map((s) => (
          <button key={s.key} role="tab" aria-selected={s.key === stratKey}
            className={`strat-card ${s.key === stratKey ? "on" : ""}`}
            onClick={() => setStratKey(s.key)}>
            <span className="strat-ico"><StratIcon k={s.key} /></span>
            <b>{s.name}</b>
            <span className="strat-tag">{s.tag}</span>
          </button>
        ))}
      </div>

      <GwPicker gi={gi} setGi={setGi}
        values={DATA.gws.map((g) => OPTIMAL[String(g)]?.xp ?? "")} />

      {busy && (
        <div className="solving" role="status">
          <span className="spinner" aria-hidden="true" />
          Solving {strat.name.toLowerCase()} for GW{DATA.gws[gi]}
          {locks.length ? ` around ${locks.length} locked player${locks.length > 1 ? "s" : ""}` : ""}
          {bans.length ? ` without ${bans.length} excluded player${bans.length > 1 ? "s" : ""}` : ""}…
        </div>
      )}

      {!busy && !ok && (
        <div className="opt-error" role="alert">
          <b>No legal squad fits that.</b>
          <span>{r?.reason}</span>
        </div>
      )}

      {!busy && ok && (
        <>
          {/* Per gameweek, not a window total. A three-week total and a
              seven-week total are not comparable magnitudes, so showing the
              total as the headline makes a longer window look like a better
              squad simply for being longer. The total stays, one line down,
              where it cannot be mistaken for a rate. */}
          {res?.tier === "provisional" && (
            <p className="opt-provisional" role="status">
              Provisional — refining…
            </p>
          )}
          <Tiles items={[
            ["Per gameweek", `${perGw.toFixed(1)} pts`, "gold"],
            ["Cost", money(r.cost)],
            ["Bank", money(BUDGET - r.cost), "green"],
          ]} />
          <p className="opt-secondary">
            {`GW${DATA.gws[gi]}–${DATA.gws[endGi]} total ${windowPts.toFixed(1)} pts`}
            {` · GW${DATA.gws[gi]} alone ${thisWeek.pts.toFixed(1)} pts`}
          </p>

          {(locks.length > 0 || bans.length > 0) && (
            <div className={`lock-verdict ${lockCost > 4 ? "warn" : lockCost > 1.5 ? "" : "good"}`}>
              <b>
                {lockCost < 0.05
                  ? `Your ${locks.length && bans.length ? "constraints" : locks.length ? "locks" : "exclusions"} cost you nothing.`
                  : `${locks.length && bans.length ? "Your locks and exclusions together cost" : locks.length ? "Locking them costs" : "Ruling them out costs"} ${lockCost.toFixed(1)} pts.`}
              </b>
              <span>
                {lockCost < 0.05
                  ? locks.length
                    ? "The unconstrained optimal squad already agrees with every one of them — you were right."
                    : "None of them makes the unconstrained optimal squad anyway — ruling them out was free."
                  : lockCost < 1.5
                    ? "Cheap enough to be worth it if you hold the view, or want the differential."
                    : lockCost < 4
                      ? `The free build scores ${res.free.pts.toFixed(1)} over this horizon against your ${r.pts.toFixed(1)}. A real but survivable cost.`
                      : `The free build scores ${res.free.pts.toFixed(1)} against your ${r.pts.toFixed(1)}. That is a lot of points to pay for a preference.`}
              </span>
            </div>
          )}

          <CaptainBar ids={ids} gi={gi} />
          <Pitch ids={ids} gi={gi} readOnly
            benchBoost={stratKey === "bb"} />

          <button className="btn primary" onClick={() => onUseSquad(ids)}>
            Use as my squad
          </button>

          {/* The controls that REFINE the answer sit under it. Strategy and
              gameweek stay above because they change the question being asked;
              horizon and locks only tune it, and burying the squad below four
              stacked panels meant scrolling past the controls to reach the one
              thing the page exists to show. */}
          {!strat.fixedSpan && (
            <div className="horizon-box">
              <div className="horizon-top">
                <label className="horizon-label">Planning window</label>
                <span className="horizon-value">
                  GW{DATA.gws[gi]}–{DATA.gws[endGi]}
                  <em>{activeSpan === 1 ? "1 week" : `${activeSpan} weeks`}</em>
                </span>
              </div>

              {/* Two handles over the same track. A window has a start AND an
                  end — "keep it for six weeks" could not express "the squad I
                  want for GW4 to GW9", which is the question anyone planning a
                  wildcard is actually asking. */}
              <div className="range2" style={{
                "--a": `${(gi / (DATA.gws.length - 1)) * 100}%`,
                "--b": `${(endGi / (DATA.gws.length - 1)) * 100}%`,
              }}>
                <div className="range2-track" aria-hidden="true" />
                <div className="range2-fill" aria-hidden="true" />
                {/* The window SLIDES. Clamping the start handle at the end
                    handle meant it could never move past it, so the window was
                    stuck against GW1 and could only ever be shortened — you
                    could ask for GW1-7 or GW2-7 and never GW9-14. Pushing the
                    far handle along preserves the span, which is what "move my
                    planning window forward" means. Dragging either handle
                    INWARD still resizes, so both gestures survive. */}
                <input className="range2-h a" type="range" aria-label="First gameweek"
                  min={0} max={DATA.gws.length - 1} step={1} value={gi}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const span = endGi - gi;
                    setGi(v);
                    if (v > endGi) {
                      setEndGi(Math.min(DATA.gws.length - 1, v + span));
                    }
                  }}
                  aria-valuetext={`GW${DATA.gws[gi]}`} />
                <input className="range2-h b" type="range" aria-label="Last gameweek"
                  min={0} max={DATA.gws.length - 1} step={1} value={endGi}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const span = endGi - gi;
                    setEndGi(v);
                    if (v < gi) setGi(Math.max(0, v - span));
                  }}
                  aria-valuetext={`GW${DATA.gws[endGi]}`} />
              </div>
              <div className="horizon-scale" aria-hidden="true">
                <span>GW{DATA.gws[0]}</span>
                <span>GW{DATA.gws[DATA.gws.length - 1]}</span>
              </div>

              {/* Weighting is a separate axis from the window, because the same
                  five gameweeks mean different things depending on whether you
                  intend to transfer out of them. */}
              <div className="weight-row">
                <span className="weight-lab">Weight gameweeks</span>
                <div className="weight-seg" role="group" aria-label="Weighting">
                  {[["decay", "By nearness"], ["flat", "Equally"]].map(([k, lab]) => (
                    <button key={k} className={`weight-btn ${weightMode === k ? "on" : ""}`}
                      aria-pressed={weightMode === k}
                      disabled={chipLocked}
                      onClick={() => setWeighting(k)}>{lab}</button>
                  ))}
                </div>
              </div>
              <p className="horizon-note">
                {chipLocked
                  ? "A chip is a commitment, so every gameweek in the window counts equally — discounting weeks you have already decided to play would score a good short-window squad badly."
                  : weightMode === "decay"
                    ? "Later gameweeks count less, because a free transfer arrives every week and can buy those points nearer the time."
                    : "Every gameweek counts the same. Right when the window is a plan you intend to keep rather than an open-ended hold."}
              </p>
              {gi > 0 && (
                <p className="horizon-caveat">
                  Starting at GW{DATA.gws[gi]} — this squad is built against
                  <b> projected</b> prices and availability for a future state, not
                  today's. Both will have moved by then.
                </p>
              )}
              <p className="horizon-note">{spanNote(activeSpan)}</p>
            </div>
          )}

          <div className="opt-split">
          <div className="opt-split-main">
          <RatingStrip squad={r.squad}
            gis={(res.weeks || []).map((w) => w.k)}
            chipOpts={{ bb: stratKey === "bb", tc: stratKey === "tc" }} />

          {!strat.fixedSpan && <Robustness ids={ids} weightMode={weightMode} />}

          </div>
          <aside className="opt-split-side">
            <ConstraintPicker mode="lock" ids={locks} setIds={setLocks}
              taken={[...locks, ...bans]} />
            <ConstraintPicker mode="ban" ids={bans} setIds={setBans}
              taken={[...locks, ...bans]} />
          </aside>
          </div>

          <p className="opt-blurb">{strat.blurb}</p>

          <div className="card flat breakdown" style={{ marginTop: 10 }}>
            <div className="row">
              <span>Starting eleven</span>
              <span className="val">
                {(thisWeek.pts - thisWeek.capt.g[gi] * (stratKey === "tc" ? 2 : 1)
                  - (stratKey === "bb" ? thisWeek.bench.reduce((s, p) => s + p.g[gi], 0) : 0)).toFixed(1)}
              </span>
            </div>
            <div className="row">
              <span>Captain ({thisWeek.capt.n}{stratKey === "tc" ? " ×3" : " ×2"})</span>
              <span className="val">
                {(thisWeek.capt.g[gi] * (stratKey === "tc" ? 2 : 1)).toFixed(1)}
              </span>
            </div>
            <div className="row">
              <span>Bench{stratKey === "bb" ? " (boosted — counts)" : " (does not count)"}</span>
              <span className={`val ${stratKey === "bb" ? "" : "muted"}`}>
                {thisWeek.bench.reduce((s, p) => s + p.g[gi], 0).toFixed(1)}
              </span>
            </div>
            <div className="row total">
              <span>GW{DATA.gws[gi]} total</span>
              <span className="val">{thisWeek.pts.toFixed(1)}</span>
            </div>
            {ceiling != null && stratKey !== "freehit" && (
              <div className="row sub">
                <span>Versus a Free Hit this week</span>
                <span className="val">
                  {(thisWeek.pts - ceiling >= 0 ? "+" : "") + (thisWeek.pts - ceiling).toFixed(1)}
                </span>
              </div>
            )}
          </div>

          {/* Three chips, three weeks, three verdicts — one line each. This was
              three tall cards with a heading, a caption and a footnote, which
              is a lot of page for what amounts to "GW14, worth it". */}
          {res.advice && (
            <div className="chiptime">
              <div className="chiptime-head">
                <b>When to play your chips</b>
                <span>on this squad, GW{DATA.gws[gi]}–{DATA.gws[Math.min(gi + Math.max(activeSpan, 6) - 1, DATA.gws.length - 1)]}</span>
              </div>
              {[
                ["Bench Boost", res.advice.bb, `+${res.advice.bb.gain.toFixed(1)} off the bench`],
                ["Triple Captain", res.advice.tc, `+${res.advice.tc.gain.toFixed(1)} from ${res.advice.tc.player?.n ?? "the armband"}`],
                ["Free Hit", res.advice.fh, `+${res.advice.fh.gain.toFixed(1)} over this squad`],
              ].map(([label, c, detail]) => (
                <div key={label} className={`ct-row ${c.worth ? "worth" : "thin"}`}>
                  <span className="ct-chip">{label}</span>
                  <span className="ct-gw">GW{c.gw}</span>
                  <span className="ct-detail">{detail}</span>
                  <span className="ct-verdict">{c.worth ? "play it" : "hold"}</span>
                </div>
              ))}
            </div>
          )}

          <p className="footnote">
            Full £{BUDGET.toFixed(1)}m, 2-5-5-3 quota, three per club, best legal
            eleven with the captain doubled. {activeSpan > 1
              ? `Scored over GW${DATA.gws[gi]}–${DATA.gws[Math.min(gi + activeSpan - 1, DATA.gws.length - 1)]} with later weeks discounted, because you keep this squad.`
              : `Scored on GW${DATA.gws[gi]} alone.`}
            {res?.ms != null && <em className="solve-time"> Solved in {res.ms}ms.</em>}
            {" "}A chip is only worth a week that is clearly better than the rest;
            where the rows above say hold, no week in range is far enough ahead
            of an ordinary one to spend it on.
          </p>
        </>
      )}
    </div>
  );
}
