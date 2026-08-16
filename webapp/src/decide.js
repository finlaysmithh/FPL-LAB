/**
 * The decision layer.
 *
 * The model underneath is unchanged. This file answers three questions and
 * nothing else:
 *
 *     1. How good is my squad?          SQUAD QUALITY
 *     2. How good is my plan?           PLAN QUALITY
 *     3. What should I do this week?    GAMEWEEK DECISION
 *
 * Everything the app used to show — five separate scores out of 100, a raw
 * score, a fixture-run label, a gap, an upside, three chip suggestions with
 * three different units — collapses into those three, plus one shared scale
 * for comparing actions.
 *
 * ---------------------------------------------------------------------------
 * NET DECISION VALUE
 * ---------------------------------------------------------------------------
 * Every action a manager can take is scored on one number: how many projected
 * points it is worth, net of what it costs, over the planning horizon.
 *
 *     NET VALUE(action) = realised horizon gain
 *                       − points cost (hits)
 *                       − chip opportunity cost
 *                       − flexibility cost
 *
 * That lets HOLD, TRANSFER, WILDCARD, FREE HIT, BENCH BOOST and TRIPLE CAPTAIN
 * be ranked against each other on the same axis, which is the whole point:
 * previously each was quoted in its own unit and none of them could be
 * compared.
 *
 * ---------------------------------------------------------------------------
 * THE 0.62 THAT CHANGES EVERYTHING
 * ---------------------------------------------------------------------------
 * Projected transfer gains do not arrive in full. Measured on 34,885 plausible
 * one-for-one swaps across two seasons of walk-forward backtest, comparing what
 * the model projected a swap would gain against what it actually gained:
 *
 *     projected   realised
 *       0.37        0.22
 *       1.24        0.68
 *       2.45        1.41
 *       3.42        2.14
 *       5.16        3.33
 *
 * Monotone — bigger projected gains really do deliver bigger realised gains, so
 * the ranking works — but the magnitude is inflated by about 38%. Every gain in
 * this file is multiplied by REALISATION before being compared against a cost,
 * because a −4 hit is a certain cost and a +4 projection is not a certain gain.
 *
 * This single factor is why the app now says HOLD far more often. It is not
 * conservatism; it is the measured conversion rate.
 */
import {
  BUDGET, DATA, OPTIMAL, benchScore, bestTransfers, bestXI, byId, clubCounts,
  gwScore, isGated, ratingCurve, squadCost, squadDepth, squadFlexibility,
} from "./logic.js";

// Measured: realised gain / projected gain over 34,885 historical swaps.
export const REALISATION = 0.62;

// A hit costs four points, and unlike the gain it is certain.
const HIT_COST = 4;

// What an unused free transfer is worth as an option on next week's news. A
// banked transfer lets you react to an injury without taking a hit, and the
// measured value of that option is roughly a quarter of a hit.
const BANKED_TRANSFER_VALUE = 1.0;

// Net value below which no action is worth taking — the difference is inside
// the model's own error bar. Derived from the measurement above: at a realised
// gain of 1.0 the standard error on a single swap is ±0.06 but the spread is
// wide, and gains under this size do not survive out of sample.
//
// HONESTY ABOUT THE THRESHOLD ITSELF. The 0.62 realisation factor is measured
// and solid — 34,885 swaps, two seasons, monotone across every band. The exact
// cut-off of 2.0 is NOT equally well established. A policy backtest was built
// to choose it and could not discriminate: the best-projected swap available
// anywhere in the league in a given week is always large, so every candidate
// threshold acted every week and all of them scored identically (4.16 net
// points per week). Distinguishing them properly needs a squad-constrained
// simulation — choosing only from fifteen owned players, carrying the squad
// forward, and respecting one transfer a week — which is a bigger piece of
// machinery than this file.
//
// So 2.0 is reasoned rather than fitted: it is roughly half a hit, which is
// the smallest edge worth spending a scarce transfer on. Treat it as a
// placeholder with a known provenance, not as a measured optimum.
export const ACT_THRESHOLD = 2.0;
export const CONSIDER_THRESHOLD = 0.8;

// A chip is only worth committing to if its best window beats its next-best by
// this much. Otherwise the honest answer is that the timing is not yet decided.
const CHIP_COMMIT_MARGIN = 2.0;

// Minimum standalone value before a chip is worth playing at all.
const CHIP_FLOOR = { bb: 12, tc: 8, fh: 8, wc: 6 };

const DISCOUNT = 0.92;   // future gameweeks are less certain, not less real

const idx = () => DATA.gws.map((_, k) => k);

/** Discounted projected points for a squad across a window. */
function windowPoints(squad, ks, capt, startIds) {
  return ks.reduce((s, k, j) =>
    s + Math.pow(DISCOUNT, j) * gwScore(squad, k, capt, startIds), 0);
}

/**
 * The planning horizon, chosen by the situation rather than fixed.
 *
 * Normally six gameweeks. But if a decision point lands sooner — a chip window
 * or a sharp fixture swing — the horizon stops there, because planning past a
 * decision you have not made yet is planning a fiction.
 */
export function planHorizon(squad, gi = 0, capt = null) {
  const all = idx().filter((k) => k >= gi);
  const base = all.slice(0, 6);
  if (base.length < 3) return base;
  // A swing is a week whose projection differs sharply from the running mean —
  // the point at which the squad you want changes.
  const pts = base.map((k) => gwScore(squad, k, capt));
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const swing = pts.findIndex((v, i) => i >= 2 && Math.abs(v - mean) > mean * 0.12);
  return swing > 0 ? base.slice(0, swing + 1) : base;
}

/**
 * SQUAD QUALITY — how strong these fifteen are, ignoring chips and timing.
 *
 * Deliberately squad-level: it must not move because a chip window opened.
 * Points are the bulk of it; depth and flexibility are folded in at a weight
 * that reflects how much they actually change outcomes, rather than being
 * shown as two more competing scores.
 */
export function squadQuality(squad, gi = 0, capt = null) {
  if (!squad || squad.length !== 15) return null;
  const ks = idx().filter((k) => k >= gi).slice(0, 6);
  const mine = ks.reduce((s, k) => s + gwScore(squad, k, capt), 0);
  const best = ks.reduce((s, k) =>
    s + (OPTIMAL[String(DATA.gws[k])]?.xp ?? gwScore(OPTIMAL.range.squad, k)), 0);
  const ratio = best > 0 ? mine / best : 0;
  const pointsScore = ratingCurve(ratio);

  const depth = squadDepth(squad, gi);
  const flex = squadFlexibility(squad);
  // 80/10/10. Points dominate because they are what the game scores; depth and
  // flexibility matter but a squad is not good because it has money in the
  // bank.
  const score = Math.round(
    0.80 * pointsScore + 0.10 * (depth?.score ?? 50) + 0.10 * (flex?.score ?? 50));

  return {
    score, band: qualityBand(score), points: mine, ceiling: best,
    ratio, depth, flex,
    weeks: ks.map((k) => DATA.gws[k]),
  };
}

/**
 * What the score MEANS, in the terms a manager actually thinks in: is this team
 * ready to play, or does it need work before the deadline?
 *
 * A number on its own does not answer that. 71/100 is a fine squad and reads
 * like a poor exam mark, and a user who cannot tell "good enough, go" from
 * "fix two things first" will either churn a working team or ship a broken one.
 */
export const readiness = (s) =>
  s >= 90 ? "Ready. This is about as good as your budget allows — play it."
  : s >= 78 ? "Ready to go. A strong squad; any change from here is fine-tuning, not repair."
  : s >= 64 ? "Playable, with room. It will score, but one or two moves would meaningfully improve it."
  : s >= 48 ? "Needs work before the deadline. Several places are costing you real points."
  : "Not ready. This squad has structural problems — consider a wildcard rather than single transfers.";

export const qualityBand = (s) =>
  s >= 90 ? { label: "ELITE", c: "#00FF87" }
  : s >= 78 ? { label: "STRONG", c: "#8BE24A" }
  : s >= 64 ? { label: "SOLID", c: "#F5C542" }
  : s >= 48 ? { label: "WEAK", c: "#F5772E" }
  : { label: "POOR", c: "#E90052" };

/**
 * Every action, on one scale.
 *
 * `free` is how many free transfers are banked. Costs are certain; gains are
 * multiplied by REALISATION first.
 */
export function actions(squad, gi = 0, capt = null, free = 1) {
  if (!squad || squad.length !== 15) return [];
  const ks = planHorizon(squad, gi, capt);
  const hold = windowPoints(squad, ks, capt);
  const out = [];

  out.push({
    key: "HOLD", label: "Keep your squad", net: 0, gross: 0, cost: 0,
    detail: "No change. The baseline every other action is measured against.",
  });

  // ---- transfers -----------------------------------------------------------
  const ideas = bestTransfers(squad, ks, 6);
  if (ideas.length) {
    const best = ideas[0];
    const gross = best.gain * REALISATION;
    // The first transfer is free if one is banked; the cost of using it is the
    // option value of keeping it for next week's news.
    const cost = free > 0 ? BANKED_TRANSFER_VALUE : HIT_COST;
    out.push({
      key: "TRANSFER", label: `${best.out.n} → ${best.in.n}`,
      net: gross - cost, gross, cost,
      move: best, alternatives: ideas.slice(1, 4),
      detail: free > 0
        ? `Uses your free transfer. Worth ${gross.toFixed(1)} realised points over ${ks.length} weeks against the ${BANKED_TRANSFER_VALUE.toFixed(1)} an unused transfer is worth as cover.`
        : `Costs a ${HIT_COST}-point hit. Needs to clear that before it is worth doing.`,
    });
  }

  // ---- wildcard ------------------------------------------------------------
  // Compared over the horizon, never on one week, and charged the value of the
  // better window it might be spent on later.
  const wcGross = wildcardValue(squad, ks, capt);
  const wcFuture = bestFutureWildcard(squad, gi, capt);
  const wcOpp = Math.max(0, wcFuture.value - wcGross);
  // THE FLOOR HAS TO BE APPLIED. `CHIP_FLOOR.wc` existed and this block never
  // consulted it, so a rebuild worth 1.5 points over the horizon was offered as
  // an action — recommending the most valuable chip in the game for less than
  // half a transfer. A wildcard is one of two you get all season; it is not
  // worth playing for anything a free transfer could have fixed.
  //
  // Below the floor it stays in the list (so the number is visible and
  // auditable) but is scored as a loss, which keeps it out of the verdict.
  const wcBelowFloor = wcGross < CHIP_FLOOR.wc;
  const wcNet = wcBelowFloor ? Math.min(-0.1, wcGross - CHIP_FLOOR.wc) : wcGross - wcOpp;
  const wcNeed = squad.filter((i) => !OPTIMAL.range.squad.includes(i)).length;
  out.push({
    key: "WILDCARD", label: "Wildcard now", net: wcNet,
    gross: wcGross, cost: wcOpp,
    changes: wcNeed,
    detail: wcBelowFloor
      ? `Only ${wcNeed} of your fifteen would change, and your free transfers get there in ${wcNeed} week${wcNeed === 1 ? "" : "s"} for nothing. A wildcard buys ${wcGross.toFixed(1)} points of time — far short of the ${CHIP_FLOOR.wc} it should return. Hold it for a fixture swing or an international break.`
      : wcOpp > 1
        ? `Rebuilding ${wcNeed} places now is worth ${wcGross.toFixed(1)} over what free transfers reach anyway, but GW${wcFuture.gw} looks worth ${wcFuture.value.toFixed(1)} — spending it now gives that up.`
        : `Rebuilding ${wcNeed} places is worth ${wcGross.toFixed(1)} realised points over what your free transfers would have reached on their own.`,
    future: wcFuture,
  });

  // ---- chips ---------------------------------------------------------------
  // ONLY chips whose state is PLAY — this week is both above the floor and the
  // best week in the range. A chip whose best window is GW14 is not an option
  // for GW1, and listing it as one produced the contradiction this guard
  // exists to stop: the headline reading "ACT: Bench Boost" while the chip
  // plan directly below read "Bench Boost — OPEN, best in GW14".
  const chips = chipWindows(squad, gi, capt);
  for (const [key, c] of Object.entries(chips)) {
    if (key === "wc" || !c || !c.now || c.state !== "PLAY") continue;
    out.push({
      key: key.toUpperCase(), label: `Play ${c.title}`, net: c.now.net,
      gross: c.now.value, cost: c.now.opportunity, detail: c.now.detail,
    });
  }

  return out.sort((a, b) => b.net - a.net);
}

/**
 * WHAT A WILDCARD IS ACTUALLY WORTH
 * ---------------------------------
 * This used to be `optimal squad − your squad`, which is why the app told
 * every user to wildcard every single week. Any ordinary squad sits 20 to 40
 * points below a perfect one over six gameweeks; multiply by the realisation
 * factor and the "wildcard now" line cleared any floor you care to set, in GW1,
 * in GW2, and in every week after that. A recommendation that fires
 * unconditionally is not a recommendation.
 *
 * The error is the baseline. You do not have to spend a wildcard to improve
 * your squad — a free transfer arrives every week, and over a six-week horizon
 * that is six changes for nothing. So the comparison that matters is not
 *
 *     wildcard squad  vs  the squad you have today
 *
 * but
 *
 *     wildcard squad  vs  the squad your free transfers reach anyway.
 *
 * What a wildcard genuinely buys is TIME: it makes every change at once instead
 * of one a week. So its value is the gap that free transfers have not closed
 * yet, week by week, and it shrinks to nothing as they catch up.
 *
 * Modelled as: free transfers close the gap at roughly one player a week, so by
 * week j you have captured j/N of it, where N is how many of your fifteen would
 * actually change. A squad needing three changes has almost nothing to gain —
 * you get there by GW4 for free. A squad needing ten has a great deal.
 *
 * APPROXIMATION, STATED. The real pathway would re-solve the best available
 * transfer each week and carry the squad forward, which is `planSeason` in
 * logic.js and far too slow to run on every render. The linear catch-up is a
 * stand-in for it. It is deliberately generous to the wildcard in one respect
 * (it assumes each free transfer is as good as a wildcard change, which
 * understates the wildcard) and harsh in another (it ignores that a wildcard
 * can restructure the budget in ways single transfers cannot).
 */
function wildcardValue(squad, ks, capt) {
  const ideal = OPTIMAL.range.squad;
  const need = squad.filter((i) => !ideal.includes(i)).length;
  if (!need) return 0;
  let v = 0;
  ks.forEach((k, j) => {
    const gap = gwScore(ideal, k) - gwScore(squad, k, capt);
    const closed = Math.min(1, j / need);        // free transfers catching up
    v += Math.pow(DISCOUNT, j) * Math.max(0, gap) * (1 - closed);
  });
  return v * REALISATION;
}

/** The best future wildcard window, so using it now can be charged for it. */
function bestFutureWildcard(squad, gi, capt) {
  const later = idx().filter((k) => k > gi);
  let best = { gw: null, value: 0 };
  for (const k of later.slice(0, 10)) {
    const ks = idx().filter((x) => x >= k).slice(0, 6);
    if (ks.length < 3) break;
    // Valued on the SAME basis as playing it now, or the opportunity cost is
    // measured against a different question and the two cannot be subtracted.
    const gain = wildcardValue(squad, ks, capt);
    if (gain > best.value) best = { gw: DATA.gws[k], value: gain, k };
  }
  return best;
}

/**
 * Chip windows, with OPEN as a legitimate answer.
 *
 * A chip is an option, not a commitment. Each is valued now and at every
 * future week, and the recommendation is only PLAY or a named week when the
 * best window clearly beats the alternatives. If it does not, the honest
 * output is OPEN — and forcing "Bench Boost GW6" out of weak evidence is worse
 * than saying nothing, because the user will plan around it.
 */
export function chipWindows(squad, gi = 0, capt = null) {
  if (!squad || squad.length !== 15) return {};
  const ks = idx().filter((k) => k >= gi);
  const mk = (key, title, valueAt, floor) => {
    const scored = ks.map((k) => ({ k, gw: DATA.gws[k], value: valueAt(k) }))
      .sort((a, b) => b.value - a.value);
    if (!scored.length) return null;
    const best = scored[0];
    const runnerUp = scored[1]?.value ?? 0;
    const nowVal = valueAt(gi);
    const margin = best.value - runnerUp;
    const worthPlaying = best.value >= floor;

    // Committing means claiming this week beats the rest by more than the
    // model's own uncertainty. Otherwise: open.
    const committed = worthPlaying && margin >= CHIP_COMMIT_MARGIN;
    const playNow = worthPlaying && best.k === gi;
    const confidence = worthPlaying
      ? Math.min(0.95, 0.5 + margin / 12 + (best.value - floor) / 40)
      : 0.4 + Math.min(0.2, best.value / (floor * 4));

    return {
      title,
      state: playNow ? "PLAY" : committed ? "WINDOW" : "OPEN",
      best: { gw: best.gw, value: best.value },
      window: scored.slice(0, 3).map((s) => s.gw).sort((a, b) => a - b),
      confidence,
      now: {
        value: nowVal,
        opportunity: Math.max(0, best.value - nowVal),
        net: nowVal * REALISATION - Math.max(0, best.value - nowVal) * REALISATION,
        detail: playNow
          ? `This is the best week for it in the range, worth ${best.value.toFixed(1)}.`
          : `Worth ${nowVal.toFixed(1)} now against ${best.value.toFixed(1)} in GW${best.gw}.`,
      },
      floor,
    };
  };

  return {
    bb: mk("bb", "Bench Boost", (k) => benchScore(squad, k), CHIP_FLOOR.bb),
    tc: mk("tc", "Triple Captain",
      (k) => bestXI(squad, k, capt).capt?.g[k] || 0, CHIP_FLOOR.tc),
    fh: mk("fh", "Free Hit",
      (k) => Math.max(0, (OPTIMAL[String(DATA.gws[k])]?.xp ?? 0)
                        - gwScore(squad, k, capt)), CHIP_FLOOR.fh),
  };
}

/**
 * PLAN QUALITY — how good the strategy is, not how good the squad is.
 *
 * A strong squad with no chip plan and no flexibility is a worse PLAN than a
 * slightly weaker squad that is well placed for the next month. This score is
 * what separates the two, and it is the one that moves when a chip window
 * opens or a fixture swing arrives.
 */
export function planQuality(squad, gi = 0, capt = null, free = 1) {
  const q = squadQuality(squad, gi, capt);
  if (!q) return null;
  const ks = planHorizon(squad, gi, capt);
  const acts = actions(squad, gi, capt, free);
  const chips = chipWindows(squad, gi, capt);

  // How much better the best available action is than holding. A plan is good
  // when there is little left on the table — not when the squad is strong in
  // isolation. Only actions available THIS week count: a chip that pays in
  // GW14 is not value being wasted now, it is value correctly being saved, and
  // charging the plan for it made a well-timed plan look weak.
  const bestNet = Math.max(0, ...acts.map((a) => a.net));
  // Scaled against a full hit: leaving more than a hit's worth of value unused
  // is a plan problem, not a squad problem.
  const efficiency = Math.max(0, 1 - bestNet / (HIT_COST * 2));

  // Chips still held and still useful are an asset; chips with no window in
  // sight are not counted against the manager.
  const chipVals = Object.values(chips).filter(Boolean);
  const chipReady = chipVals.length
    ? chipVals.filter((c) => c.best.value >= c.floor).length / chipVals.length
    : 0;

  const score = Math.round(
    0.55 * q.score + 0.30 * (efficiency * 100) + 0.15 * (chipReady * 100));

  return {
    score, band: qualityBand(score), horizon: ks.map((k) => DATA.gws[k]),
    squad: q, actions: acts, chips, bestNet, efficiency, chipReady,
    points: ks.reduce((s, k) => s + gwScore(squad, k, capt), 0),
    weekly: ks.map((k) => ({ gw: DATA.gws[k], pts: gwScore(squad, k, capt) })),
  };
}

/**
 * THIS GAMEWEEK — one recommendation, in plain language.
 *
 * Thresholds are the measured ones, not round numbers: a projected gain has to
 * survive the 0.62 realisation factor and still clear the cost of acting.
 */
export function gameweekDecision(squad, gi = 0, capt = null, free = 1) {
  const plan = planQuality(squad, gi, capt, free);
  if (!plan) return null;
  const acts = plan.actions;
  const top = acts.find((a) => a.key !== "HOLD");
  const hold = acts.find((a) => a.key === "HOLD");

  let verdict, headline, why = [];
  if (!top || top.net < CONSIDER_THRESHOLD) {
    verdict = "HOLD";
    headline = free > 0 ? "Save the transfer" : "No change needed";
    why.push(!top
      ? "Nothing available improves this squad."
      : top.net < 0
      ? `The best move available actually costs ${Math.abs(top.net).toFixed(1)} net points once the hit and the 0.62 realisation factor are applied.`
      : `The best move is worth only ${top.net.toFixed(1)} net points — inside the model's own margin of error.`);
  } else if (top.net < ACT_THRESHOLD) {
    verdict = "CONSIDER";
    headline = top.label;
    why.push(`Worth about ${top.net.toFixed(1)} net points. Real, but not urgent.`);
  } else {
    verdict = "ACT";
    headline = top.label;
    why.push(`Worth ${top.net.toFixed(1)} net points over the next ${plan.horizon.length} gameweeks.`);
  }

  // Supporting reasons, capped at three. More than three and nobody reads them.
  const q = plan.squad;
  if (q.flex?.dead) {
    why.push(`${q.flex.dead} player${q.flex.dead > 1 ? "s" : ""} in your fifteen ${q.flex.dead > 1 ? "are" : "is"} not projected to play.`);
  }
  const openChip = Object.values(plan.chips).find((c) => c && c.state === "PLAY");
  if (openChip) why.push(`${openChip.title} is at its best week of the range now.`);
  else {
    const soon = Object.values(plan.chips)
      .filter((c) => c && c.state === "WINDOW")
      .sort((a, b) => a.best.gw - b.best.gw)[0];
    if (soon) why.push(`${soon.title} looks best around GW${soon.best.gw} — worth holding for.`);
  }
  if (why.length < 3 && q.depth) {
    why.push(`${q.depth.playable}/4 substitutes are projected to play, so cover is ${q.depth.playable >= 3 ? "good" : "thin"}.`);
  }

  // Confidence: how clearly the top action beats the next one, tempered by how
  // far ahead we are asking the model to see.
  const second = acts.filter((a) => a.key !== top?.key)[0];
  const sep = top && second ? Math.abs(top.net - second.net) : 0;
  const confidence = Math.max(0.5, Math.min(0.92,
    0.55 + sep / 10 - (plan.horizon.length - 4) * 0.02));

  // The next moment worth re-checking: the first chip window, or a fixture
  // swing, whichever lands sooner.
  const nextGw = nextDecisionPoint(plan, gi);

  return {
    verdict, headline, why: why.slice(0, 3), confidence,
    action: top, hold, plan,
    thisWeekPoints: gwScore(squad, gi, capt),
    bestAlternative: (OPTIMAL[String(DATA.gws[gi])]?.xp ?? null),
    next: nextGw,
  };
}

function nextDecisionPoint(plan, gi) {
  const windows = Object.values(plan.chips)
    .filter((c) => c && c.state !== "OPEN" && c.best.gw > DATA.gws[gi])
    .map((c) => ({ gw: c.best.gw, why: `${c.title} window` }));
  const swingGw = plan.horizon[plan.horizon.length - 1];
  const swing = { gw: swingGw, why: "end of the current fixture run" };
  const all = [...windows, swing].sort((a, b) => a.gw - b.gw);
  return all[0] || null;
}
