import { DecisionPanel } from "./Decision.jsx";
import React, { useMemo, useState } from "react";
import {
  BUDGET, DATA, MIN_MINUTES, MIN_START_PCT, OPTIMAL, POS_LABEL, POS_ORDER, QUOTA,
  bestTransfers, bestXI, startsEnough,
  benchScore, byId, fdrColor, fdrInk, grade, gwScore, isGated, money,
  bestChipWeeks, canSwap, formationName, isLegalXI, planSeason, rateSquad, shapeOptions,
  ratingBand, squadCost, transferVerdict, validate,
  gradeTone, playerGrade, playerRating,
} from "./logic.js";
import { clubCounts } from "./logic.js";
import { TEAM_NAMES } from "./kits.js";
import { Breakdown, CaptainBar, FixtureStrip, GwPicker, Jersey, Tiles } from "./components.jsx";
import { MarketPanel } from "./MarketPanel.jsx";
import { SwapSheet } from "./SwapSheet.jsx";
import { WeekBar } from "./WeekBar.jsx";
import { Timeline } from "./Timeline.jsx";
import { emptyPlan, resolvePlan } from "./plan.js";
import { StrategyBar } from "./Strategy.jsx";
import { QualityPanel } from "./Quality.jsx";
import { ManagerCard, buildAdvice } from "./Manager.jsx";
import { Pitch, PitchSvg } from "./Pitch.jsx";

const xiSum = (ids, gi) => bestXI(ids, gi).xi.reduce((s, p) => s + p.g[gi], 0);

/** Identity of a squad, order-independent. Used to tell drafts apart. */
const fingerprint = (ids) => [...(ids || [])].sort((a, b) => a - b).join(",");
/** How many players differ between a stamped fingerprint and a squad. */
const changedCount = (stamp, ids) => {
  const had = new Set(String(stamp || "").split(",").filter(Boolean).map(Number));
  return (ids || []).filter((i) => !had.has(i)).length;
};

// Squad rating over three horizons, with the chip weeks you have chosen folded
// in. The scores move as you set a wildcard or free hit, which is the point:
// a chip is only worth playing where it actually changes the number.
//
// Four things per card and no more: the horizon, the score, the band, the
// projected points. Everything else these used to carry — the gap to a perfect
// squad, what one transfer is worth — is a sentence, not a statistic, and the
// gaffer says it below in the words it deserves. The one addition is the run of
// fixtures, because that now moves the score and a number nobody can account
// for is worse than no number at all.
function RatingStrip({ rating }) {
  if (!rating) return null;
  const span = (r) => (r.weeks.length === 1
    ? `GW${r.weeks[0]}`
    : `GW${r.weeks[0]}–${r.weeks[r.weeks.length - 1]}`);
  const cards = [["This week", rating.now], ["Next 3", rating.h3], ["Next 6", rating.h6]];
  return (
    <div className="rating-row">
      {cards.map(([label, r]) => {
        const band = ratingBand(r.score);
        return (
          <div key={label} className="rating-card">
            <div className="rating-k">
              {label}<em>{span(r)}</em>
            </div>
            <div className="rating-n" style={{ color: band.c }}>
              {r.score}<i>/100</i>
            </div>
            <div className="rating-bar">
              <div style={{ width: `${r.score}%`, background: band.c }} />
            </div>
            <div className="rating-foot">
              <span className="rating-band" style={{ color: band.c }}>{band.label}</span>
              <span className="rating-pts">{r.points.toFixed(0)} pts</span>
              {r.run.tone && (
                <span className="rating-run" style={{ color: r.run.c }}
                  title={r.raw > r.score
                    ? `${r.raw - r.score} points docked for the fixtures your fifteen face over ${span(r)}.`
                    : `Kind fixtures over ${span(r)}. Already paid for in the projection, so the score is not marked up twice.`}>
                  {r.run.label}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <SquadQuality rating={rating} />
    </div>
  );
}

/**
 * Bench and flexibility, beside the points score rather than inside it.
 *
 * The headline answers "how strong is this fifteen this week". A manager
 * building a wildcard draft needs two more answers that raw points cannot
 * give: can the bench actually cover a blank, and can the squad still be
 * moved. A squad with four playable substitutes and money in the bank is a
 * genuinely better wildcard than an identically-projecting one with a dead
 * bench and three clubs already capped — and averaging those into one number
 * would hide exactly the thing worth knowing.
 */
function SquadQuality({ rating }) {
  const { depth, flex } = rating || {};
  if (!depth && !flex) return null;
  const rows = [
    depth && {
      k: "Bench", v: depth.score,
      d: `${depth.playable}/4 subs projected to play · ${depth.benchPts.toFixed(1)} pts sitting there`,
    },
    flex && {
      k: "Flexibility", v: flex.score,
      d: [`£${flex.bank.toFixed(1)}m banked`,
          flex.blocked ? `${flex.blocked} club${flex.blocked > 1 ? "s" : ""} capped` : null,
          flex.dead ? `${flex.dead} non-playing slot${flex.dead > 1 ? "s" : ""}` : null,
      ].filter(Boolean).join(" · "),
    },
  ].filter(Boolean);
  return (
    <div className="rating-card quality">
      <div className="rating-k">Squad quality<em>beyond points</em></div>
      {rows.map((r) => {
        const b = ratingBand(r.v);
        return (
          <div key={r.k} className="sq-row">
            <div className="sq-head">
              <span className="sq-k">{r.k}</span>
              <span className="sq-v" style={{ color: b.c }}>{r.v}</span>
            </div>
            <div className="rating-bar">
              <div style={{ width: `${r.v}%`, background: b.c }} />
            </div>
            <div className="sq-d">{r.d}</div>
          </div>
        );
      })}
    </div>
  );
}

// The chip plan sits BELOW the pitch. Four chips across nineteen gameweeks is
// 76 controls, and above the pitch it meant scrolling past a wall of buttons
// to reach your own starting eleven.
// Ten gameweeks. Nineteen was planning against minutes nobody can know in
// August; the fixtures are published that far out but the team sheets are not.
const PLAN_WEEKS = DATA.gws.length;


function ChipPlanner({ chips, setChips, suggest }) {
  const [openChips, setOpenChips] = useState(false);
  const setChip = (key, gw) =>
    setChips((c) => ({ ...c, [key]: c[key] === gw ? null : gw }));
  return (
      <div className="chip-planner">
        <button className="chip-planner-head" onClick={() => setOpenChips((v) => !v)}
          aria-expanded={openChips}>
          <span>Chip plan</span>
          <span className="cp-hint">
            {(() => {
              const on = Object.entries(chips).filter(([, v]) => v);
              const nm = { wildcardGw: "WC", freeHitGw: "FH", benchBoostGw: "BB", tripleCaptainGw: "TC" };
              return on.length
                ? on.map(([k, v]) => `${nm[k]} GW${v}`).join(" · ")
                : "None set — tap to plan";
            })()}
          </span>
        </button>
        {openChips && (<>
        {[["wildcardGw", "Wildcard", "Rebuild the squad from this week on"],
          ["freeHitGw", "Free Hit", "Play this one week with the perfect fifteen"],
          ["benchBoostGw", "Bench Boost", "Your four substitutes score as well"],
          ["tripleCaptainGw", "Triple Captain", "The armband pays three times, not two"]].map(([key, label, blurb]) => (
          <div key={key} className="cp-row">
            <div className="cp-label">
              <b>{label}</b>
              <span>{blurb}</span>
            </div>
            <div className="cp-weeks">
              {DATA.gws.map((g) => (
                <button key={g}
                  className={`cp-week ${chips[key] === g ? "on" : ""}`}
                  aria-pressed={chips[key] === g}
                  onClick={() => setChip(key, g)}>
                  {g}
                </button>
              ))}
            </div>
          </div>
        ))}
        {Object.values(chips).some(Boolean) && (
          <button className="btn quiet" style={{ marginTop: 8, marginBottom: 0 }}
            onClick={() => setChips({
              wildcardGw: null, freeHitGw: null, benchBoostGw: null, tripleCaptainGw: null })}>
            Clear chip plan
          </button>
        )}
        </>)}
        {suggest && (
          <div className="cp-suggest">
            <b>Where they pay most on this squad:</b>
            {suggest.bb && <span>Bench Boost GW{suggest.bb.gw} ({suggest.bb.value.toFixed(1)} on the bench)</span>}
            {suggest.tc && <span>Triple Captain GW{suggest.tc.gw} ({suggest.tc.value.toFixed(1)} for the armband)</span>}
            {suggest.fh && suggest.fh.value > 0 && <span>Free Hit GW{suggest.fh.gw} (+{suggest.fh.value.toFixed(1)} over your own XI)</span>}
          </div>
        )}
      </div>
  );
}

// Which shape your fifteen should actually play this week. Forwards average
// more points per start than midfielders, and midfielders more than defenders
// (2025/26: 4.13 / 3.97 / 3.70), so the 4-5-1 most managers default to is
// rarely the best available — worth showing rather than asserting.
function ShapePicker({ squad, gi, current, onPick }) {
  const [open, setOpen] = useState(false);
  const opts = shapeOptions(squad, gi);
  if (!opts.length) return null;
  const best = opts[0];
  const now = opts.find((o) => o.name === current);
  const gain = now ? best.pts - now.pts : 0;

  return (
    <div className="shapes">
      <button className="shapes-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>
          {gain > 0.05
            ? <>Your best shape this week is <b>{best.name}</b>, worth <b>+{gain.toFixed(1)}</b> over {current}</>
            : <>You are already in the best shape available — <b>{current}</b></>}
        </span>
        <span className="shapes-toggle">{open ? "Hide" : "Compare all"}</span>
      </button>
      {open && (
        <div className="shapes-list">
          {opts.map((o) => (
            <button key={o.name} className={`shape-row ${o.name === current ? "on" : ""}`}
              onClick={() => onPick(o)}>
              <span className="shape-name">{o.name}</span>
              <div className="shape-track">
                <div style={{ width: `${(o.pts / best.pts) * 100}%` }} />
              </div>
              <span className="shape-pts">{o.pts.toFixed(1)}</span>
              <span className="shape-delta">
                {o.name === current ? "now" : `${o.pts >= (now?.pts ?? 0) ? "+" : ""}${(o.pts - (now?.pts ?? 0)).toFixed(1)}`}
              </span>
            </button>
          ))}
          <p className="footnote" style={{ margin: "6px 2px 0" }}>
            Scored on your own fifteen for GW{DATA.gws[gi]}, captain included.
            Picking one sets your eleven to the best players for that shape.
          </p>
        </div>
      )}
    </div>
  );
}

// Rows to aim for per position on the Value tab — enough to compare real
// alternatives at the same money, not so many it stops being a shortlist.
// Raised from 20 once the start-probability gate came in: the old list was
// short AND padded with players who do not start, which is the worst of both.
const TARGET_ROWS = 32;

// ============ MY SQUAD (main page) ============
export function SquadTab({
  gi, setGi, squad, capt, saveSquad, saveCapt, openSwap, wide, market, side, setSide,
  setMarketPos, onSwapIn,
}) {
  const [sheet, setSheet] = useState(null); // player action sheet
  const [chips, setChips] = useState({
    wildcardGw: null, freeHitGw: null, benchBoostGw: null, tripleCaptainGw: null });
  // The season plan, persisted. A plan a user loses on refresh is not a plan.
  const [plan, setPlanState] = useState(() => {
    try {
      const raw = localStorage.getItem("fpllab:plan");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && Array.isArray(parsed.base) ? parsed : null;
    } catch { return null; }
  });
  // Every saved plan is STAMPED with the squad it was written for. A plan is a
  // list of moves off a particular fifteen; replayed onto a different fifteen
  // it is nonsense, and the nonsense is expensive — a stale draft's 26 planned
  // transfers landed on a freshly imported squad as 24 paid moves and a 96-point
  // deduction, which is where the "-96" and the 9-point gameweek came from.
  const setPlan = (next) => {
    const stamped = next && { ...next, for: fingerprint(next.base || squad) };
    setPlanState(stamped);
    try { localStorage.setItem("fpllab:plan", JSON.stringify(stamped)); } catch {}
  };
  // A manually chosen eleven. Null means "let the model pick", which is the
  // default; once you substitute anyone we hold your shape instead.
  const [startIds, setStartIds] = useState(null);
  const [subSel, setSubSel] = useState(null);

  // ---- ONE market, reachable at every width -----------------------------
  //
  // The market used to be a right-hand panel that only existed above 1000px,
  // and "Transfer out" merely switched which panel that column was showing. On
  // a desktop scrolled down to the pitch, the panel changed somewhere off
  // screen and the button read as dead. Asking to transfer a player out is an
  // explicit act, so it now opens a dialog at every width — you cannot miss it,
  // and there is no breakpoint at which the button does nothing.
  //
  // Declared HERE, with the other hooks, because there is an early return below
  // and a hook after it changes the hook count between renders.
  const [mkt, setMkt] = useState(null);          // { out, pos } | null

  const complete = squad.length === 15 && validate(squad).length === 0;

  // Free transfers banked, and chips already played. The app cannot read either
  // from anywhere, and both change every recommendation on the page, so they
  // are asked for once and remembered. Chips especially: without this a
  // wildcard you played in GW1 goes on being recommended for the rest of the
  // season, which is exactly how a one-shot asset becomes a weekly nag.
  const [free, setFreeState] = useState(() => {
    const raw = localStorage.getItem("fpllab:ft");
    if (raw == null) return 1;                 // Number(null) is 0, not NaN
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 1;
  });
  const setFree = (n) => {
    setFreeState(n);
    try { localStorage.setItem("fpllab:ft", String(n)); } catch {}
  };
  const [spent, setSpentState] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("fpllab:chips") || "[]");
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  });
  const setSpent = (next) => {
    setSpentState(next);
    try { localStorage.setItem("fpllab:chips", JSON.stringify(next)); } catch {}
  };

  // EVERY hook must run before the early return below. Placing this memo after
  // it meant removing a player changed the number of hooks React saw between
  // renders — "Rendered fewer hooks than expected" — and took the whole page to
  // a blank screen. An early return is only safe once nothing hook-shaped
  // follows it.
  // The plan is ALWAYS anchored on the squad you own right now.
  //
  // It used to resolve against `plan.base`, which was frozen at the moment the
  // plan was first saved and never re-synced. Change your squad afterwards and
  // every downstream panel kept reasoning about the old fifteen — which is why
  // the transfer suggestions offered to sell players the user no longer owned.
  // A saved plan is a list of INTENDED MOVES, not a snapshot of a team; the team
  // is whatever `squad` currently is. Moves that reference players who have
  // since left are skipped by `resolvePlan`'s own legality check.
  // A plan written for a DIFFERENT squad is discarded rather than replayed.
  //
  // Re-anchoring `base` on the current fifteen was necessary but not
  // sufficient: the per-week transfers survived, so importing a new draft
  // replayed the old draft's moves on top of it. Two or three changed players
  // is ordinary editing and the plan still applies; a wholesale swap means this
  // is a different team and the moves belong to the team that left.
  const planStale = !!(plan?.for && plan.for !== fingerprint(squad)
    && changedCount(plan.for, squad) > 3);
  const planned = useMemo(
    () => (complete
      ? resolvePlan(
          planStale ? { base: squad, weeks: {} } : { ...(plan || {}), base: squad },
          DATA.gws.length)
      : []),
    [plan, squad.join(","), complete, planStale]);

  // Drop a stale plan for good rather than re-checking it every render, so it
  // cannot be written back to storage and resurrected later.
  React.useEffect(() => { if (planStale) setPlan(null); }, [planStale]);

  // ---- ONE write path for squad changes -------------------------------
  //
  // This is the fix for "a transfer in GW3 changes GW1". The engine was always
  // right — `resolvePlan` walks forward, so week k's moves only affect week k
  // onward. The bug was that there were TWO ways to change a squad and they
  // wrote to different places: the week bar wrote a transfer into
  // `plan.weeks[k]`, while the pitch and the market called `saveSquad`, which
  // overwrites `squad` — and `squad` IS `plan.base`, the GW1 team. So editing
  // from the pitch while looking at GW3 silently rewrote every week.
  //
  // Now every edit comes through here. Viewing GW1 edits the base, because GW1
  // IS the base. Viewing any later week records the difference as that week's
  // transfers and leaves everything before it untouched.
  const editSquad = (nextIds) => {
    if (!complete || gi === 0 || !plan?.base?.length) return saveSquad(nextIds);
    const at = planned[gi];
    if (!at) return saveSquad(nextIds);
    const before = at.squad;
    const out = before.filter((i) => !nextIds.includes(i));
    const inn = nextIds.filter((i) => !before.includes(i));
    if (!out.length && !inn.length) return;
    const pairs = out.map((o, j) => ({ out: o, in: inn[j] })).filter((m) => m.in != null);
    if (!pairs.length) return saveSquad(nextIds);

    // CHAINS COLLAPSE. Changing your mind is not two transfers.
    //
    // This used to append every edit, so swapping A→B and then B→C recorded
    // BOTH — two transfers, one of them paid, for a single change of mind.
    // Browsing the market a dozen times built a plan with 26 transfers and a
    // 96-point deduction, which is what turned a 57-point gameweek into 9.
    //
    // So a new move that starts where an existing one ended rewrites it:
    // A→B followed by B→C is A→C, and A→B followed by B→A is no move at all.
    const merged = [...(plan.weeks[gi]?.transfers || [])];
    for (const m of pairs) {
      const chain = merged.findIndex((x) => x.in === m.out);
      if (chain < 0) { merged.push(m); continue; }
      if (merged[chain].out === m.in) merged.splice(chain, 1);   // back where it started
      else merged[chain] = { out: merged[chain].out, in: m.in };
    }

    setPlan({
      ...plan,
      weeks: {
        ...plan.weeks,
        [gi]: { ...(plan.weeks[gi] || {}), transfers: merged },
      },
    });
  };

  // The squad as it stands in the week being viewed — base plus every move
  // planned up to and including it.
  const weekSquad = (complete && planned[gi]?.squad) || squad;

  if (!complete) {
    return <SquadBuilder squad={squad} saveSquad={saveSquad} openSwap={openSwap}
      wide={wide} market={market} setMarketPos={setMarketPos} onSwapIn={onSwapIn} gi={gi} />;
  }

  // The bar reads the resolved PLAN, not the current squad repeated nineteen
  // times — otherwise a bench boost toggled in GW7 changes the plan score and
  // silently disagrees with the number printed above GW7.
  const per = DATA.gws.map((_, k) =>
    planned[k] ? planned[k].points : gwScore(squad, k, capt, startIds));
  const total = per.reduce((a, b) => a + b, 0);
  // Same arithmetic as `total` (XI + captain, per week) on the solver's
  // held-range squad — the MILP objective itself is discounted and not
  // comparable to a raw points sum.
  const optTotal = DATA.gws.reduce((s, _, k) => s + gwScore(OPTIMAL.range.squad, k), 0);
  const pct = Math.min((total / optTotal) * 100, 100);
  const gr = grade(pct);
  // EVERYTHING below reasons about `weekSquad` — the fifteen you actually have
  // in the week on screen — never about `squad`, which is only the GW1 base.
  //
  // This was the bug behind "it keeps telling me to sell players I don't own".
  // The pitch drew `weekSquad` while the transfer engine, the rating and the
  // decision panel were all handed `squad`, so the moment a plan moved anyone,
  // the advice was about a team that was no longer on the screen.
  const { xi, bench, capt: captP, autoCapt } = bestXI(weekSquad, gi, capt, startIds);
  const nextIdeas = bestTransfers(weekSquad, [gi], 4);
  const rangeIdeas = bestTransfers(weekSquad, DATA.gws.map((_, k) => k), 4);
  const rating = rateSquad(weekSquad, capt, { ...chips, gi, startIds });

  // Which shirts may legally swap with the one picked up.
  const legalTargets = (() => {
    if (subSel == null) return null;
    const sel = byId[subSel];
    const onPitch = xi.some((p) => p.i === subSel);
    const others = onPitch ? bench : xi;
    const set = new Set();
    others.forEach((o) => {
      const a = onPitch ? o : sel, b = onPitch ? sel : o;   // a comes on, b goes off
      if (canSwap(xi, a, b)) set.add(o.i);
    });
    return set;
  })();

  const applySub = (other) => {
    const cur = xi.map((p) => p.i);
    const onPitch = cur.includes(subSel);
    const next = onPitch
      ? cur.map((i) => (i === subSel ? other.i : i))
      : cur.map((i) => (i === other.i ? subSel : i));
    if (isLegalXI(next.map((i) => byId[i]))) setStartIds(next);
    setSubSel(null);
  };
  const topIdea = rangeIdeas[0] || nextIdeas[0] || null;
  const verdict = topIdea ? transferVerdict(topIdea.gain) : null;
  const advice = buildAdvice({ squad: weekSquad, capt, gi, rating, topTransfer: topIdea, verdict });

  const mktPos = (pos) =>
    setMkt((m) => ({ pos, out: m && byId[m.out]?.p === pos ? m.out : null }));

  // Swaps go through `editSquad`, so a transfer made while viewing GW3 is
  // recorded as a GW3 move rather than silently rewriting your GW1 team.
  const swapInHere = (id) => {
    if (mkt?.out != null) {
      editSquad(weekSquad.map((x) => (x === mkt.out ? id : x)));
      if (capt === mkt.out) saveCapt(null);
      setMkt(null);
      return;
    }
    const p = byId[id];
    if (!p) return;
    const have = weekSquad.map((i) => byId[i]).filter(Boolean);
    if (have.filter((q) => q.p === p.p).length >= QUOTA[p.p]) return;
    if ((clubCounts(weekSquad)[p.t] || 0) >= 3) return;
    editSquad([...weekSquad, id]);
    setMkt(null);
  };

  return (
    <div className="page">
      <Timeline gi={gi} setGi={setGi} weeks={planned} />

      {/* THE PLAN SPANS BOTH COLUMNS.
          It is the answer the page exists to give, so it gets the full width at
          the top rather than a third of it in a column. Everything below is
          split: the TEAM on the left, the ANALYSIS that comments on it in the
          right rail — which is also what stops the rail being a 400px empty
          band running down two thousand pixels of page. */}
      <StrategyBar squad={weekSquad} gi={gi} free={free} setFree={setFree}
        spent={spent} setSpent={setSpent} planWeeks={planned} />

      <div className="cols">
      <div className="col-main">
      {/* ORDER MATTERS. The pitch comes first: it is the thing the user came to
          look at, and burying it under three analysis panels meant scrolling
          past a wall of numbers to reach your own team. Everything below it is
          commentary on what is above it. */}
      {/* How good is this, with the scale drawn rather than asserted. */}
      <QualityPanel squad={weekSquad} gi={gi} capt={capt} />

      <Tiles items={[
        [`GW${DATA.gws[gi]} projected`, (rating?.now.points ?? per[gi]).toFixed(1), "gold"],
        ["Value", money(squadCost(weekSquad))],
        ["Bank", money(BUDGET - squadCost(weekSquad)), "green"],
      ]} />

      <Pitch ids={weekSquad} gi={gi} captId={capt} startIds={startIds}
        onTap={(p) => setSheet(p)}
        subSel={subSel} legalTargets={legalTargets}
        onSubTap={applySub} onCancelSub={() => setSubSel(null)}
        benchBoost={chips.benchBoostGw === DATA.gws[gi]} />
      {startIds && (
        <div className="shape-note">
          Playing your own <b>{formationName(xi)}</b>, not the model's pick.
          <button onClick={() => { setStartIds(null); setSubSel(null); }}>Use the best XI</button>
        </div>
      )}

      <CaptainBar ids={weekSquad} gi={gi} captId={capt} />
      {autoCapt && (
        <p className="hint">Armband is on your best projected starter — tap any player to hand it to someone else.</p>
      )}

      <div style={{ marginTop: 10 }}>
        <Breakdown xi={xi.reduce((s2, p) => s2 + p.g[gi], 0)} capt={captP?.g[gi] || 0}
          bench={benchScore(weekSquad, gi, startIds)}
          benchCounts={chips.benchBoostGw === DATA.gws[gi]}
          tripled={chips.tripleCaptainGw === DATA.gws[gi]}
          total={(rating?.now.points ?? per[gi]).toFixed(1)} gw={DATA.gws[gi]} />
      </div>

      <ShapePicker squad={weekSquad} gi={gi} current={formationName(xi)}
        onPick={(o) => { setStartIds(o.ids); setSubSel(null); }} />

      </div>

      <div className="col-side">
      {wide && (
        <div className="seg" style={{ marginBottom: 14 }}>
          <button className={`seg-btn ${side === "plan" ? "on" : ""}`}
            onClick={() => setSide("plan")}>Plan</button>
          <button className={`seg-btn ${side === "market" ? "on" : ""}`}
            onClick={() => setSide("market")}>Transfers</button>
        </div>
      )}

      {wide && side === "market" ? (
        // Browsing the market, as opposed to replacing a named player. Reads
        // and writes `weekSquad` so it agrees with the pitch beside it.
        <MarketPanel squad={weekSquad} gi={gi} out={null}
          pos={market?.pos || "MID"} setPos={setMarketPos}
          onSwapIn={swapInHere} onCancel={() => setSide("plan")} />
      ) : (
      <>
      {/* THE RIGHT RAIL IS THE ANALYSIS COLUMN.
          It used to hold 412px of content beside a 2771px team column, so for
          most of the page it was a 400px-wide strip of nothing. The week
          planner and the gaffer's reasoning are commentary on the team rather
          than part of it, so they belong here — which balances the two columns
          and shortens the page by roughly a third. */}
      <DecisionPanel squad={weekSquad} capt={capt} gi={gi} free={free} part="body" />

      <WeekBar gi={gi} setGi={setGi} plan={plan} setPlan={setPlan} squad={squad} />

      {/* The gaffer's card is GONE, and this is the third and last copy of the
          same advice to go. It restated the transfer verdict the plan bar gives
          at the top of the page, in different words and from a different model,
          so the page could read "roll your transfer" twice and "play your bench
          boost" once and leave a user to referee it. One question, one answer. */}

      <details className="dq-more">
        <summary>Horizon breakdown</summary>
        <RatingStrip rating={rating} />
      </details>

      <details className="plan-fold">
        <summary>
          Transfer plan · GW{DATA.gws[0]}–{DATA.gws[PLAN_WEEKS - 1]}
          <em>the whole run, week by week</em>
        </summary>
      <Planner squad={weekSquad} />
      </details>

      {/* Destructive, and demoted to look it. It sat here as a full-width
          button with the same weight as the analysis above it. */}
      <button className="btn danger-quiet"
        onClick={() => {
          if (window.confirm("Clear your squad and start again? This cannot be undone."))
            { saveSquad([]); saveCapt(null); }
        }}>
        Clear squad
      </button>
      </>
      )}
      </div>
      </div>

      {sheet && (
        <div className="action-veil" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div className="action-card" role="dialog" aria-label={`${sheet.n} actions`}>
            <div className="action-head">
              <Jersey team={sheet.t} size={30} />
              <div>
                <div className="action-name">{sheet.n}</div>
                <div className="action-meta">
                  {TEAM_NAMES[sheet.t] || sheet.t} · {sheet.p} · {money(sheet.c)}
                </div>
              </div>
            </div>
            {sheet.st && (
              <p className="action-note warn">
                {sheet.st === "d"
                  ? `Doubtful — ${sheet.ch != null ? sheet.ch + "% chance of playing" : "50% assumed"}.`
                  : "Ruled out (injured, suspended or unavailable)."}
                {sheet.nw ? ` ${sheet.nw}` : ""}
              </p>
            )}
            {sheet.pr === 1 && (
              <p className="action-note">
                No usable Premier League record — projections here are estimated
                from price, not measured output.
              </p>
            )}
            {xi.some((q) => q.i === sheet.i) && sheet.i !== captP?.i && (
              <button className="btn primary" onClick={() => { saveCapt(sheet.i); setSheet(null); }}>
                Make captain
              </button>
            )}
            {sheet.i === captP?.i && !autoCapt && (
              <button className="btn ghost" onClick={() => { saveCapt(null); setSheet(null); }}>
                Back to automatic captain
              </button>
            )}
            <button className="btn ghost" onClick={() => { setSubSel(sheet.i); setSheet(null); }}>
              {xi.some((q) => q.i === sheet.i) ? "Move to the bench" : "Bring on"}
            </button>
            <button className="btn primary" onClick={() => { setMkt({ out: sheet.i, pos: sheet.p }); setSheet(null); }}>
              Transfer out for another {sheet.p}
            </button>
            <button className="btn quiet" onClick={() => {
              // `weekSquad`, not `squad` — remove the man you are looking at.
              editSquad(weekSquad.filter((x) => x !== sheet.i));
              if (capt === sheet.i) saveCapt(null);
              setSheet(null);
            }}>
              Remove from squad
            </button>
            <button className="btn quiet" onClick={() => setSheet(null)}>Close</button>
          </div>
        </div>
      )}

      {/* The market, as a dialog, at every width. */}
      <SwapSheet open={!!mkt} pos={mkt?.pos || "MID"} setPos={mktPos}
        current={mkt?.out ?? null} squad={weekSquad} gi={gi}
        onPick={swapInHere} onClose={() => setMkt(null)} />
    </div>
  );
}

function SquadBuilder({
  squad, saveSquad, openSwap, wide, market, setMarketPos, onSwapIn, gi,
}) {
  const cost = squadCost(squad);
  const bank = BUDGET - cost;
  return (
    <div className="page">
      <div className="cols">
      <div className="col-main">
      <div className="hero-import">
        <div className="eyebrow">My Squad</div>
        <h2>Pick your fifteen.<br /><em>£100.0m. Your call.</em></h2>
        <p>
          Every player registered this season is in the pool. Fill all fifteen
          shirts — 2 keepers, 5 defenders, 5 midfielders, 3 forwards, max 3 per
          club — and Matrix picks your best XI each week and projects the lot.
        </p>
      </div>

      <Tiles items={[
        ["Spent", money(cost), cost > BUDGET ? "pink" : ""],
        ["Bank", money(bank), bank < 0 ? "pink" : "green"],
        ["Players", `${squad.length}/15`, squad.length === 15 ? "green" : ""],
      ]} />
      {cost > BUDGET && <div className="err-strip">{money(cost - BUDGET)} over budget — downgrade someone.</div>}

      {/* The squad takes shape on the pitch it will be played on, rather than
          in an abstract grid — empty shirts show exactly what is still missing. */}
      <div className="pitch-wrap">
        <PitchSvg />
        <div className="pitch-rows">
          {POS_ORDER.map((pos) => {
            const mine = squad.map((i) => byId[i]).filter((p) => p && p.p === pos);
            const empty = Math.max(0, QUOTA[pos] - mine.length);
            return (
              <div key={pos} className="pitch-row">
                {mine.map((p) => (
                  <button key={p.i} className="build-slot filled"
                    onClick={() => openSwap({ out: p.i, pos })}
                    aria-label={`${p.n}, ${money(p.c)} — replace or remove`}>
                    <Jersey team={p.t} size={34} />
                    <span className="bs-name">{p.n}</span>
                    <span className="bs-price">{money(p.c)}</span>
                  </button>
                ))}
                {Array.from({ length: empty }).map((_, k) => (
                  <button key={`e${k}`} className="build-slot empty"
                    onClick={() => openSwap({ out: null, pos })}
                    aria-label={`Add a ${POS_LABEL[pos]}`}>
                    <span className="bs-plus" aria-hidden="true">+</span>
                    <span className="bs-name">Add {pos}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={() => saveSquad(OPTIMAL.range.squad)}>
          Skip it — load the optimal squad and tweak from there
        </button>
        {squad.length > 0 && (
          <button className="btn quiet" onClick={() => saveSquad([])}>Clear all</button>
        )}
      </div>
      </div>

      {/* Without this the desktop "Add" buttons set state that nothing renders. */}
      {wide && (
        <div className="col-side">
          <MarketPanel squad={squad} gi={gi} out={market?.out ?? null}
            pos={market?.pos || "GK"} setPos={setMarketPos}
            onSwapIn={onSwapIn} onCancel={() => setMarketPos(market?.pos || "GK")} />
        </div>
      )}
      </div>
    </div>
  );
}

function TransferCard({ t, label, gi, onClick, showFixtures }) {
  // Both grades, side by side. A transfer is a COMPARISON, and a bare "+1.2"
  // does not say whether you are upgrading a C into an A or shuffling one A+
  // for another — which is the difference between a move worth making and one
  // that spends a transfer to stand still.
  const gOut = playerGrade(t.out, gi), gIn = playerGrade(t.in, gi);
  const rOut = playerRating(t.out, gi) ?? 0, rIn = playerRating(t.in, gi) ?? 0;
  const step = rIn - rOut;
  const verdict =
    step >= 18 ? { k: "up", t: "Clear upgrade" }
    : step >= 7 ? { k: "up", t: "Modest upgrade" }
    : step > -7 ? { k: "flat", t: "Like for like — little to gain" }
    : { k: "down", t: "Downgrade on grade" };
  return (
    <button className="tx-card" onClick={onClick}>
      <div className="tx-main">
        <div className="tx-names">
          <div className="tx-out">
            <span className={`tx-g g-${gradeTone(gOut)}`}>{gOut}</span>
            − {t.out.n} <span className="meta">{t.out.t} · {money(t.out.c)}</span>
          </div>
          <div className="tx-in">
            <span className={`tx-g g-${gradeTone(gIn)}`}>{gIn}</span>
            + {t.in.n} <span className="meta">{t.in.t} · {money(t.in.c)}</span>
          </div>
        </div>
        <div className="tx-gain">
          <div className="n">+{t.gain.toFixed(1)}</div>
          <div className="l">{label}</div>
        </div>
      </div>
      <div className={`tx-verdict ${verdict.k}`}>
        {gOut} → {gIn} · {verdict.t}
      </div>
      {showFixtures && <div className="tx-foot"><FixtureStrip team={t.in.t} gi={gi} /></div>}
    </button>
  );
}

function Planner({ squad }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!plan) {
    return (
      <div className="card">
        <p className="page-blurb" style={{ marginBottom: 10 }}>
          Plan the whole run: one free transfer a week (bankable to five), the
          best move or a roll each week, and the week each chip is worth most.
          Later gameweeks are fixtures without team sheets, so treat the far end
          as a shape rather than a schedule.
        </p>
        <button className="btn primary" disabled={busy} style={{ margin: 0 }}
          onClick={() => {
            setBusy(true);
            setTimeout(() => { setPlan(planSeason(squad)); setBusy(false); }, 20);
          }}>
          {busy ? "Solving…" : `Plan GW${DATA.gws[0]}–${DATA.gws[PLAN_WEEKS - 1]}`}
        </button>
      </div>
    );
  }

  const { weeks, total, chips } = plan;
  return (
    <>
      <div className="card flat" style={{ marginBottom: 10 }}>
        <div className="breakdown">
          <div className="row total" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
            <span>Planned total</span><span className="val">{total.toFixed(1)} pts</span>
          </div>
        </div>
      </div>

      {/* The old chip block lived here and picked each chip's best week on
          IMMEDIATE points alone, which put Triple Captain in GW2 and Bench
          Boost in GW18 while the strategic model on the squad page said GW10
          and GW6. Two answers to one question, and no way for a user to tell
          which to believe.

          There is now one chip model — `advice.chipStrategy`, which scores the
          whole season including international breaks and fixture swings — and
          it lives beside the week you are deciding on. This block is gone
          rather than reconciled: the question belongs where the decision is
          made, not in a plan you open once a week. */}

      {weeks.map((w) => (
        <div key={w.gw} className="plan-week">
          <div className="plan-head">
            <span className="plan-gw">GW{w.gw}</span>
            <span className="plan-xp">{w.xp.toFixed(1)} pts</span>
          </div>
          {w.move ? (
            <div className="plan-move">
              <span className="tx-out">− {w.move.out.n}</span>
              <span className="tx-in">+ {w.move.in.n}</span>
              <span className="plan-gain">+{w.move.gain.toFixed(1)}</span>
            </div>
          ) : (
            <div className="plan-roll">
              Roll the transfer — nothing gains {2.0} pts or more. {w.ftAfter} banked.
            </div>
          )}
          <div className="plan-capt">
            (C) {w.captain?.n} · {((w.captain?.g[w.k] || 0) * 2).toFixed(1)} pts
            {chips.tc.gw === w.gw && chips.tc.worth && <span className="tag doubt">TRIPLE</span>}
            {chips.bb.gw === w.gw && chips.bb.worth && <span className="tag proxy">BENCH BOOST</span>}
            {chips.fh.gw === w.gw && chips.fh.worth && <span className="tag out">FREE HIT</span>}
          </div>
        </div>
      ))}

      <div className="section-title">Chips</div>
      <div className={`advice ${chips.bb.worth ? "good" : ""}`}>
        <div className="advice-head">
          <span className="c">Bench Boost</span>
          <span className="gw">GW{chips.bb.gw}</span>
        </div>
        <p>
          {chips.bb.worth
            ? `Your bench projects ${chips.bb.value.toFixed(1)} in GW${chips.bb.gw} — the best week of the range, and enough to be worth the chip.`
            : `Best bench week is only ${chips.bb.value.toFixed(1)}. The bench scores nothing without the chip, so hold — you want 12+ before playing it.`}
        </p>
      </div>
      <div className={`advice ${chips.tc.worth ? "good" : ""}`}>
        <div className="advice-head">
          <span className="c">Triple Captain</span>
          <span className="gw">GW{chips.tc.gw}</span>
        </div>
        <p>
          {chips.tc.player?.n} projects {chips.tc.value.toFixed(1)} in GW{chips.tc.gw}
          {chips.tc.worth
            ? " — strong enough to triple."
            : ", below the 6.0 bar. Hold it for a home tie against a leaky defence."}
        </p>
      </div>
      <div className={`advice ${chips.fh.worth ? "warn" : ""}`}>
        <div className="advice-head">
          <span className="c">Free Hit</span>
          <span className="gw">GW{chips.fh.gw}</span>
        </div>
        <p>
          {chips.fh.worth
            ? `GW${chips.fh.gw} is where your squad falls furthest short of a one-week optimal — a ${chips.fh.gap.toFixed(1)} point gap. Free Hit buys that week's best fifteen and hands your squad back after.`
            : `Your worst week trails the one-week optimal by ${chips.fh.gap.toFixed(1)} points. That is not enough to burn a Free Hit — save it for a blank or a double.`}
        </p>
      </div>
      <button className="btn quiet" onClick={() => setPlan(null)}>Reset plan</button>
    </>
  );
}

// The Optimal tab now lives in Optimal.jsx: it solves live against the
// user's chip strategy and locked players, which needed more room than a
// section of this file.

// ============ VALUE ============
export function ValueTab() {
  return (
    <div className="page">
      <div className="eyebrow">Value</div>
      <p className="page-blurb">
        The best picks at every price, with the runners-up alongside them so you
        can weigh real alternatives at the same money. £100m is a trade-off, not
        a ranking — every premium is paid for by an enabler elsewhere.
      </p>
      <div className="legend-box">
        <div><b style={{ color: "var(--gold)" }}>Gold price</b> — the best you
          can buy at that price beats everything cheaper. A genuine upgrade.</div>
        <div><b style={{ color: "var(--ink-dim)" }}>Grey bar</b> — a trap: you
          pay more than the price below and project the same or less.</div>
        <div><b style={{ color: "var(--green)" }}>Green number</b> — points per
          £m over {DATA.gws.length} gameweeks. How hard the money works.</div>
        <div><b>White number</b> — total projected points over the
          {" "}{DATA.gws.length} gameweeks. How good he actually is.</div>
        <div className="legend-note">
          Cheap is only value if he starts. Everyone below a {MIN_START_PCT}%
          chance of starting is left out — that covers the injured, the rotated
          and the third-choice alike, because all three show up in the same
          number. The cheapest players who genuinely do start are listed below.
        </div>
      </div>
      {POS_ORDER.map((pos) => {
        // Only players who would actually take the field. A cheap enabler who
        // never starts is not a value pick, it is a hole in the squad.
        const all = DATA.players.filter((p) => p.p === pos && startsEnough(p));
        const prices = [...new Set(all.map((p) => p.c))].sort((a, b) => a - b);
        // Fill TARGET rows: where a position has few distinct prices we show the
        // runners-up too, so you can compare like-for-like alternatives at the
        // same money instead of only the single best.
        const perPrice = Math.max(1, Math.ceil(TARGET_ROWS / Math.max(prices.length, 1)));
        const picked = prices.flatMap((c) =>
          all.filter((p) => p.c === c).sort((a, b) => b.x - a.x).slice(0, perPrice));
        // An even slice per price under-fills badly, because the thin prices
        // cannot supply their share and nothing takes it up: six defender price
        // points at six each promised 32 rows and delivered 26. Top up from
        // whoever is left, best first, so the table is as deep as it claims.
        const have = new Set(picked.map((p) => p.i));
        const topUp = all.filter((p) => !have.has(p.i)).sort((a, b) => b.x - a.x)
          .slice(0, Math.max(0, TARGET_ROWS - picked.length));
        const bands = [...picked, ...topUp].sort((a, b) => a.c - b.c || b.x - a.x);
        const maxX = Math.max(...bands.map((b) => b.x), 1);
        // "Jump" = the best you can get at this price beats everything cheaper.
        // Runners-up are never jumps, so track the leader per price separately.
        let running = -1;
        const isJump = {};
        prices.forEach((c) => {
          const best = all.filter((p) => p.c === c).reduce((a, b) => (b.x > a.x ? b : a), { x: -1 });
          if (best.x > running) { isJump[best.i] = true; running = best.x; }
        });
        return (
          <div key={pos}>
            <div className="pos-head">
              <span className="p">{pos}</span>
              <span className="d">{bands.length} shown · {prices.length} price points</span>
            </div>
            {bands.map((b) => {
              const jump = !!isJump[b.i];
              return (
                <div key={b.i} className="band-row">
                  <span className={`band-price ${jump ? "jump" : ""}`}>{b.c.toFixed(1)}</span>
                  <div className="band-bar">
                    <div className={`band-fill ${jump ? "jump" : "trap"}`}
                      style={{ width: `${(b.x / maxX) * 100}%` }} />
                    <span className="band-name">{b.n}<span>{b.t}</span></span>
                  </div>
                  <span className="band-val">{(b.x / b.c).toFixed(1)}</span>
                  <span className="band-x">{b.x.toFixed(1)}</span>
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="section-title">Cheapest players who actually start</div>
      <p className="page-blurb">
        Bench fodder only does its job if he turns up. These are the cheapest
        players at each position with a 70%+ chance of starting — sorted by
        price, then by how nailed they are.
      </p>
      {POS_ORDER.map((pos) => {
        const safe = DATA.players
          .filter((p) => p.p === pos && !p.st && (p.ps ?? 0) >= 70)
          .sort((a, b) => a.c - b.c || (b.ps ?? 0) - (a.ps ?? 0))
          .slice(0, 6);
        if (!safe.length) return null;
        return (
          <div key={pos} className="enabler-block">
            <div className="pos-head">
              <span className="p">{pos}</span>
              <span className="d">cheapest nailed</span>
            </div>
            {safe.map((p) => (
              <div key={p.i} className="enabler-row">
                <Jersey team={p.t} size={22} />
                <span className="en-name">{p.n}</span>
                <span className="en-team">{p.t}</span>
                <span className="en-mins" title="Chance of starting">{p.ps}%</span>
                <span className="en-price">{money(p.c)}</span>
                <span className="en-x">{p.x.toFixed(1)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
