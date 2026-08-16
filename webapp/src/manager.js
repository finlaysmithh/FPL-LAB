/**
 * THE MANAGER
 * ===========
 *
 * One question, asked properly:
 *
 *     Given my squad, this gameweek, my transfers, my chips and the fixtures,
 *     what would the best FPL manager actually do?
 *
 * Not "which eleven have the highest xPts". That question has a trivial answer
 * and it is the wrong one, for reasons this file makes concrete.
 *
 * NOTHING HERE PREDICTS ANYTHING. Every number comes from the existing model:
 * `p.g[k]` is the projection, `p.pp` / `p.ps` / `p.p60` come from the minutes
 * model, fixtures come from the FDR table, and squad optimisation goes through
 * `solver.js`. This is a decision layer over the top of them, which is the only
 * kind of upgrade worth making here — a second prediction system competing with
 * the first would just be two answers and no way to choose.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HIGHEST-xPTS ELEVEN IS THE WRONG ELEVEN
 * ---------------------------------------------------------------------------
 * FPL substitutes automatically. A starter who plays zero minutes is replaced
 * by the first player on your bench who played, provided the formation stays
 * legal. So the cost of starting a doubtful player is NOT his projection — it
 * is the gap between him and whoever covers him, and that gap depends on the
 * bench you built and the order you left it in.
 *
 * That single rule is why all five decisions on this page are one decision:
 *
 *     the eleven      changes what the bench can cover
 *     the formation   changes which substitutions are legal at all
 *     the bench order changes who covers whom
 *     the captain     changes what a blank costs you (double)
 *     the vice        is the only thing standing behind that
 *
 * Selecting them one at a time, each against raw xPts, gets all five slightly
 * wrong in a way that compounds. So this file optimises the whole team sheet
 * against one objective: expected points under the real FPL scoring and
 * substitution rules.
 *
 * ---------------------------------------------------------------------------
 * THE MARGINS ARE SMALLER THAN THE MODEL'S ERROR
 * ---------------------------------------------------------------------------
 * Measured on the current projections: the gap between the weakest starter and
 * the best substitute is routinely 0.06 to 0.13 points. The model's own mean
 * absolute error one week ahead is 2.006 points a player. Those decisions are
 * not decisions — they are coin flips being reported to two decimal places.
 *
 * And genuinely different players sit inside that margin. Hume projects 3.61 on
 * a 100% start probability; Hincapie projects 3.61 on 66%. Identical
 * projections, completely different risk. Ranking on xPts alone cannot see it.
 *
 * Hence TOLERANCE: differences below it are treated as ties and broken on
 * minutes security instead. See the constant for what it is and is not.
 */
import {
  BUDGET, DATA, FORMATIONS, OPTIMAL, XI_MAX, XI_MIN, bestTransfers, byId,
  captainValue, clubCounts, fixtureAt, gwScore, isGated, squadCost,
} from "./logic.js";
import { CONSIDER_THRESHOLD, REALISATION } from "./decide.js";
import { chipWeeks, optimise, templateSquad, weekScore, wildcardWeeks } from "./solver.js";

const POS = ["GK", "DEF", "MID", "FWD"];

/**
 * The size of difference this model is not entitled to have an opinion about.
 *
 * PROVENANCE, HONESTLY. This is reasoned, not fitted — the same status as
 * ACT_THRESHOLD in decide.js, and it should be read with the same suspicion.
 *
 * What IS measured: the projection's mean absolute error one gameweek ahead is
 * 2.006 points a player (data/horizon_decay.csv, 30 walk-forward passes), and
 * starter-versus-substitute margins in a real squad are 0.06–0.13 points.
 *
 * What is NOT measured is the error on the DIFFERENCE between two projections,
 * which is the quantity actually relevant here and is much smaller than the
 * error on either one — most of that 2.006 is irreducible match variance that
 * lands on both players alike. Measuring it properly needs per-player
 * walk-forward predictions that the backtest does not currently retain.
 *
 * So 0.25 is a judgement: about an eighth of the one-week error bar. Large
 * enough to catch the identical-projection cases the tie-break exists for,
 * small enough that it never overturns a gap a manager would consider real.
 * Treat it as a placeholder with a known provenance.
 */
export const TOLERANCE = 0.25;

/**
 * How much more secure the alternative has to be before a tie is broken on it.
 *
 * Five points of security is a difference a manager would notice and act on;
 * one point is not, and letting the tie-break fire on it would churn the team
 * sheet week to week for no reason anybody could explain.
 *
 * A worked example of what this is FOR, because the raw objective genuinely
 * disagrees with it. In GW4 the expected-points maximum starts Guéhi over
 * Tarkowski: Guéhi projects 0.06 less but is worth more GIVEN he plays
 * (3.85 against 3.76), and the bench covers the extra risk. That is correct
 * arithmetic and it wins by 0.065 points — about a thirtieth of the model's own
 * one-week error. Acting on it means fielding the less certain player, every
 * week, on a margin the model cannot actually see. So inside TOLERANCE the
 * nailed player starts, and the reason is stated rather than hidden.
 */
const SECURITY_EDGE = 0.05;

// ---------------------------------------------------------------------------
// Minutes
// ---------------------------------------------------------------------------
// Availability is already inside these numbers — `minutes.estimate` multiplies
// the start rate by the availability flag before anything else sees it, so an
// injury, a suspension and a rotation risk all arrive here as one lower
// probability. Do not multiply by a flag again.

/** P(plays at least one minute). The autosub only fires on a literal zero. */
export const pPlay = (p) => (p?.pp != null ? p.pp / 100 : (p?.ps ?? 0) / 100);
/** P(starts). */
export const pStart = (p) => (p?.ps ?? 0) / 100;
/** P(reaches 60 minutes) — the second appearance point, and a decent proxy for
 *  "is he actually trusted" as distinct from "does he get on the pitch". */
export const p60 = (p) => (p?.p60 ?? 0) / 100;

/**
 * Minutes security, 0–1: how confident are we this player's projection will be
 * realised by him rather than by whoever replaces him?
 *
 * Weighted toward p60 rather than P(start) on purpose. A player who starts and
 * is hooked on the hour is a different asset from one who plays ninety, and the
 * start probability alone cannot tell them apart.
 */
export const security = (p) => 0.4 * pStart(p) + 0.6 * p60(p);

/** Expected points GIVEN he appears — what a substitute is worth once on. */
const conditional = (p, k) => {
  const q = pPlay(p);
  return q > 0.02 ? p.g[k] / q : 0;
};

// ---------------------------------------------------------------------------
// Formation and substitution legality
// ---------------------------------------------------------------------------

const countOf = (players) => {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) if (c[p.p] != null) c[p.p]++;
  return c;
};

export const shapeOf = (xi) => {
  const c = countOf(xi);
  return `${c.DEF}-${c.MID}-${c.FWD}`;
};

const legalShape = (c) =>
  c.GK === 1 && FORMATIONS.some(([d, m, f]) => c.DEF === d && c.MID === m && c.FWD === f);

/**
 * Could this substitution actually be made?
 *
 * FPL walks the bench in order and makes the swap only if the side is still a
 * legal formation afterwards. A bench player who cannot legally replace this
 * particular starter is skipped WITHOUT being used up — he is still available
 * to cover someone else — which is why the loop below only consumes a
 * candidate when he was eligible in the first place.
 */
function subLegal(cnt, outPos, inPos) {
  if (outPos === "GK" || inPos === "GK") return outPos === "GK" && inPos === "GK";
  const c = { ...cnt };
  c[outPos]--;
  c[inPos]++;
  return legalShape(c);
}

/**
 * Expected points recovered when a starter in `outPos` plays nothing.
 *
 * Walks the bench in the order given. `miss` is the probability that every
 * eligible substitute ahead of this one also failed to appear.
 *
 * The algebra collapses pleasantly: the chance a substitute appears times his
 * points-given-he-appears is just his unconditional projection, so each term is
 * `P(everyone before him blanked) * g`.
 */
function recovery(cnt, outPos, benchOut, benchGK, k) {
  if (outPos === "GK") return benchGK ? benchGK.g[k] : 0;
  let acc = 0, miss = 1;
  for (const b of benchOut) {
    if (!subLegal(cnt, outPos, b.p)) continue;
    acc += miss * b.g[k];
    miss *= 1 - pPlay(b);
    if (miss < 0.001) break;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// The objective
// ---------------------------------------------------------------------------

/**
 * Expected points of a complete team sheet under the real rules.
 *
 *   base       everyone's projection (already minutes-weighted)
 *   cover      what the bench recovers when a starter blanks
 *   armband    the captain's second helping, falling to the vice if he
 *              plays nothing at all
 *
 * APPROXIMATION, STATED: each starter's cover is computed as though he were the
 * only one to blank. Two blanks in the same week would compete for the same
 * substitute, so this is very slightly optimistic. With start probabilities
 * mostly above 0.85 the double-blank term is second order, and correcting it
 * exactly means summing over every subset of the eleven.
 */
export function teamSheetEV(xi, benchOut, benchGK, capt, vice, k, { bb = false, tc = false } = {}) {
  const cnt = countOf(xi);
  let base = 0, cover = 0;
  for (const p of xi) {
    base += p.g[k];
    const q = pPlay(p);
    if (q < 0.999) cover += (1 - q) * recovery(cnt, p.p, benchOut, benchGK, k);
  }

  // The armband pays again (three times on Triple Captain). If the captain
  // plays nothing the vice inherits it — which is the entire reason the vice
  // is a decision and not a formality.
  const mult = tc ? 2 : 1;
  let armband = 0;
  if (capt) {
    armband = mult * (capt.g[k] + (1 - pPlay(capt)) * (vice ? vice.g[k] : 0));
  }

  // Bench Boost: everyone scores, and nobody is covering anybody.
  let bench = 0;
  if (bb) {
    for (const p of [...benchOut, benchGK].filter(Boolean)) bench += p.g[k];
    cover = 0;
  }

  return { ev: base + cover + armband + bench, base, cover, armband, bench };
}

// ---------------------------------------------------------------------------
// Bench order
// ---------------------------------------------------------------------------
// The best substitute is not the highest scorer left over. It is whoever
// maximises what the bench actually recovers, and that depends on how likely
// each one is to be on a pitch at all — a 6-point substitute who starts 40% of
// the time covers less than a 4-point one who never misses.
//
// Three outfield substitutes is six orderings, so this is enumerated exactly
// rather than approximated.

const PERMS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

function bestBenchOrder(xi, benchOut, benchGK, capt, vice, k, opts) {
  if (benchOut.length <= 1) return { order: benchOut, ev: teamSheetEV(xi, benchOut, benchGK, capt, vice, k, opts).ev };
  if (benchOut.length === 2) {
    const a = [benchOut[0], benchOut[1]], b = [benchOut[1], benchOut[0]];
    const ea = teamSheetEV(xi, a, benchGK, capt, vice, k, opts).ev;
    const eb = teamSheetEV(xi, b, benchGK, capt, vice, k, opts).ev;
    return ea >= eb ? { order: a, ev: ea } : { order: b, ev: eb };
  }
  let best = null;
  for (const perm of PERMS3) {
    const order = perm.map((i) => benchOut[i]);
    const ev = teamSheetEV(xi, order, benchGK, capt, vice, k, opts).ev;
    if (!best || ev > best.ev + 1e-9) best = { order, ev };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Captain and vice
// ---------------------------------------------------------------------------

/**
 * The armband is worth `captain + P(captain blanks) * vice`, so the pair is
 * chosen together. Picking the two highest projections separately is wrong
 * whenever the best captain is also the riskiest — exactly the case where the
 * vice matters most.
 *
 * `captainValue` (from logic.js, unchanged) supplies the ceiling-aware ranking:
 * the armband is a rank-order weapon, so a player who can return fourteen is
 * worth more than his mean suggests against one who cannot.
 */
export function pickArmband(xi, k, forcedCaptId) {
  if (!xi.length) return { capt: null, vice: null, why: [], close: [] };

  const ranked = [...xi].sort((a, b) => captainValue(b, k) - captainValue(a, k));
  const forced = forcedCaptId != null ? xi.find((p) => p.i === forcedCaptId) : null;

  // Within tolerance, the more reliable player takes it. A captain is a
  // doubled bet and doubling a rotation risk doubles the rotation risk.
  let capt = forced || ranked[0];
  const close = [];
  if (!forced) {
    for (const c of ranked.slice(1)) {
      const gap = captainValue(capt, k) - captainValue(c, k);
      if (gap > TOLERANCE) break;
      close.push(c);
      if (security(c) - security(capt) > SECURITY_EDGE) capt = c;
    }
  }

  // The vice is worth exactly what he covers: P(captain plays nothing) times
  // his own projection. That makes it a real optimisation and not "second
  // highest" — and it correctly stops caring when the captain is nailed.
  const vice = [...xi].filter((p) => p.i !== capt.i)
    .sort((a, b) => (b.g[k] * pPlay(b)) - (a.g[k] * pPlay(a)))[0] || null;

  const why = [];
  const captRisk = 1 - pPlay(capt);
  why.push(`${capt.n} has the best combination of projection (${capt.g[k].toFixed(1)}), ceiling and minutes security in your eleven.`);
  if (close.length && close.some((c) => c.i !== capt.i)) {
    const near = close.filter((c) => c.i !== capt.i)[0];
    if (near) why.push(`${near.n} is inside the margin at ${near.g[k].toFixed(1)} — ${security(capt) > security(near) ? `${capt.n} is the safer start` : "it is close to a coin flip"}.`);
  }
  if (vice) {
    why.push(captRisk > 0.08
      ? `${vice.n} is vice because ${capt.n} is only ${Math.round(pPlay(capt) * 100)}% to feature — the armband moving is a real possibility.`
      : `${vice.n} is vice, though ${capt.n} is ${Math.round(pPlay(capt) * 100)}% to play so it should not come to that.`);
  }

  return { capt, vice, why, close: close.filter((c) => c.i !== capt.i) };
}

// ---------------------------------------------------------------------------
// The team sheet
// ---------------------------------------------------------------------------

/**
 * Pick the eleven, the shape, the bench order, the captain and the vice —
 * jointly, against expected points under the real rules.
 *
 * All seven legal shapes are tried. Within each, a greedy seed by projection is
 * improved by swapping starters against substitutes, re-solving the bench order
 * and the armband each time, because those three decisions are coupled.
 */
export function pickTeam(squadIds, k, {
  captId = null, lockXI = null, bb = false, tc = false,
} = {}) {
  const pool = squadIds.map((i) => byId[i]).filter(Boolean);
  if (pool.length < 11) return null;
  const opts = { bb, tc };

  // A manually chosen eleven is respected as given — the user's team, the
  // user's call — but everything downstream of it is still optimised.
  if (lockXI && lockXI.length === 11) {
    const xi = lockXI.map((i) => byId[i]).filter(Boolean);
    if (xi.length === 11 && legalShape(countOf(xi))) {
      return finish(pool, xi, k, captId, opts, true);
    }
  }

  // Naming a captain is naming a starter. If the armband is forced onto a
  // player, he has to be in the eleven — otherwise the objective is free to
  // drop him and hand the armband silently back to someone else, which is the
  // opposite of obeying the instruction.
  const mustStart = new Set();
  if (captId != null && pool.some((p) => p.i === captId)) mustStart.add(captId);

  let best = null;
  for (const [d, m, f] of FORMATIONS) {
    const seed = seedXI(pool, k, d, m, f, mustStart);
    if (!seed) continue;
    const improved = improve(pool, seed, k, captId, opts, mustStart);
    if (!best || improved.ev > best.ev + 1e-9) best = improved;
  }
  if (!best) return null;

  return finish(pool, best.xi, k, captId, opts, false, mustStart);
}

/**
 * Highest projections that fill the shape — a starting point, not an answer.
 *
 * Anyone in `mustStart` is placed first and the shape is filled around him. A
 * formation with no slot for him is not a candidate at all.
 */
function seedXI(pool, k, d, m, f, mustStart = new Set()) {
  const want = { GK: 1, DEF: d, MID: m, FWD: f };
  const by = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of pool) if (by[p.p]) by[p.p].push(p);
  for (const pos of POS) by[pos].sort((a, b) => b.g[k] - a.g[k]);
  if (by.GK.length < 1 || by.DEF.length < d || by.MID.length < m || by.FWD.length < f) return null;

  const xi = [];
  const taken = new Set();
  for (const p of pool) {
    if (!mustStart.has(p.i)) continue;
    if (want[p.p] <= 0) return null;      // no room for him in this shape
    want[p.p]--;
    xi.push(p);
    taken.add(p.i);
  }
  for (const pos of POS) {
    for (const p of by[pos]) {
      if (want[pos] <= 0) break;
      if (taken.has(p.i)) continue;
      xi.push(p);
      taken.add(p.i);
      want[pos]--;
    }
  }
  return xi.length === 11 ? xi : null;
}

/** Score a candidate eleven with its bench order and armband solved. */
function evaluate(pool, xi, k, captId, opts) {
  const inXI = new Set(xi.map((p) => p.i));
  const rest = pool.filter((p) => !inXI.has(p.i));
  const benchGK = rest.find((p) => p.p === "GK") || null;
  const benchOut = rest.filter((p) => p.p !== "GK");
  const { capt, vice } = pickArmband(xi, k, captId);
  const { order, ev } = bestBenchOrder(xi, benchOut, benchGK, capt, vice, k, opts);
  return { xi, benchOut: order, benchGK, capt, vice, ev };
}

/** Swap starters against substitutes while it helps. */
function improve(pool, seedXi, k, captId, opts, mustStart = new Set()) {
  let cur = evaluate(pool, seedXi, k, captId, opts);
  for (let pass = 0; pass < 4; pass++) {
    let bestSwap = null;
    const inXI = new Set(cur.xi.map((p) => p.i));
    const rest = pool.filter((p) => !inXI.has(p.i));
    for (const out of cur.xi) {
      if (mustStart.has(out.i)) continue;
      for (const inn of rest) {
        const next = cur.xi.map((p) => (p.i === out.i ? inn : p));
        if (!legalShape(countOf(next))) continue;
        const r = evaluate(pool, next, k, captId, opts);
        if (r.ev > cur.ev + 1e-9 && (!bestSwap || r.ev > bestSwap.ev)) bestSwap = r;
      }
    }
    if (!bestSwap) break;
    cur = bestSwap;
  }
  return cur;
}

/**
 * Final pass: the tie-break, then the explanations.
 *
 * WHY A TIE-BREAK AT ALL, when the objective already prices minutes in? Because
 * expected points reward risk whenever the bench can cover it — start a 70%
 * player behind a strong bench and the maths is close to indifferent. But the
 * cover is itself conditional on the substitute appearing, on the formation
 * staying legal, and on the blank being a literal zero rather than a five-minute
 * cameo that blocks the substitution entirely. Three things have to go right.
 *
 * So inside the model's own margin, prefer the outcome that needs fewer of
 * them. That is not conservatism; it is declining to spend a real risk on a
 * difference the model cannot see.
 */
function finish(pool, xiIn, k, captId, opts, manual, mustStart = new Set()) {
  let cur = evaluate(pool, xiIn, k, captId, opts);
  const swaps = [];

  if (!manual) {
    for (let pass = 0; pass < 2; pass++) {
      let applied = false;
      const inXI = new Set(cur.xi.map((p) => p.i));
      const rest = pool.filter((p) => !inXI.has(p.i));
      for (const out of cur.xi) {
        if (mustStart.has(out.i)) continue;
        for (const inn of rest) {
          if (inn.p === "GK" || out.p === "GK") continue;
          const next = cur.xi.map((p) => (p.i === out.i ? inn : p));
          if (!legalShape(countOf(next))) continue;
          const r = evaluate(pool, next, k, captId, opts);
          const cost = cur.ev - r.ev;
          const gain = security(inn) - security(out);
          if (cost >= 0 && cost < TOLERANCE && gain > SECURITY_EDGE) {
            swaps.push({
              in: inn, out, cost, gain,
              why: `${inn.n} starts ahead of ${out.n}: ${(cost).toFixed(2)} points behind on projection, which is inside the model's margin, but ${Math.round(gain * 100)}pp more secure for minutes.`,
            });
            cur = r;
            applied = true;
            break;
          }
        }
        if (applied) break;
      }
      if (!applied) break;
    }
  }

  const arm = pickArmband(cur.xi, k, captId);
  const parts = teamSheetEV(cur.xi, cur.benchOut, cur.benchGK, arm.capt, arm.vice, k, opts);
  const bench = [cur.benchGK, ...cur.benchOut].filter(Boolean);

  // The raw comparison: what a naive "eleven highest projections" would field,
  // so the page can show that the difference is deliberate.
  const naive = naiveXI(pool, k);
  const naiveIds = new Set(naive.map((p) => p.i));
  const changed = cur.xi.filter((p) => !naiveIds.has(p.i));

  return {
    xi: cur.xi,
    bench,                       // [GK, first sub, second, third] — FPL order
    benchOut: cur.benchOut,
    benchGK: cur.benchGK,
    capt: arm.capt,
    vice: arm.vice,
    formation: shapeOf(cur.xi),
    ev: parts.ev,
    parts,
    manual,
    tieBreaks: swaps,
    captainWhy: arm.why,
    captainClose: arm.close,
    differsFromNaive: changed,
    naive,
    benchWhy: benchWhy(cur, k),
    shapeWhy: shapeWhy(pool, cur, k, captId, opts),
  };
}

/** The eleven highest projections, legal shape aside — the thing NOT to do. */
function naiveXI(pool, k) {
  const sorted = [...pool].sort((a, b) => b.g[k] - a.g[k]);
  const xi = [];
  const cnt = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pos of POS) {
    for (const p of sorted.filter((q) => q.p === pos).slice(0, XI_MIN[pos])) {
      xi.push(p); cnt[pos]++;
    }
  }
  for (const p of sorted) {
    if (xi.length >= 11) break;
    if (xi.includes(p) || cnt[p.p] >= XI_MAX[p.p]) continue;
    xi.push(p); cnt[p.p]++;
  }
  return xi;
}

/**
 * Why the bench is in this order.
 *
 * The ranking is by points GIVEN HE APPEARS, not by projection — and that is
 * the one genuinely counter-intuitive thing on the page, so it gets said
 * plainly. An autosub only fires for a player who actually played, so the
 * probability he features has already done its work by the time the
 * substitution is possible at all. What matters from there is what he is worth
 * once he is on, which is his projection divided by his chance of appearing.
 *
 * Consequence, and it looks wrong until you see why: a 90% starter projecting
 * 3.60 can rightly out-rank a 100% starter projecting 3.82, because 3.60/0.90
 * beats 3.82/1.00 — and if the first man does not play you simply fall through
 * to the second anyway.
 */
function benchWhy(cur, k) {
  const out = [];
  const first = cur.benchOut[0];
  if (!first) return out;

  const byPts = [...cur.benchOut].sort((a, b) => b.g[k] - a.g[k]);
  const top = byPts[0];
  if (top && top.i !== first.i) {
    out.push(`${first.n} is first sub ahead of ${top.n} even though he projects lower overall. A substitution only happens for a player who actually played, so what counts is his value once he is on: ${conditional(first, k).toFixed(2)} against ${conditional(top, k).toFixed(2)}. If ${first.n} does not feature, ${top.n} covers instead.`);
  } else {
    out.push(`${first.n} is first sub: the most valuable cover once he is on the pitch, which is what an autosub actually buys you.`);
  }

  const dead = cur.benchOut.filter((p) => pPlay(p) < 0.35);
  if (dead.length) {
    out.push(`${dead.map((p) => p.n).join(" and ")} ${dead.length > 1 ? "are" : "is"} unlikely to play at all, so ${dead.length > 1 ? "they provide" : "he provides"} no real cover.`);
  }
  return out;
}

function shapeWhy(pool, cur, k, captId, opts) {
  const alts = [];
  for (const [d, m, f] of FORMATIONS) {
    const seed = seedXI(pool, k, d, m, f);
    if (!seed) continue;
    const r = evaluate(pool, seed, k, captId, opts);
    alts.push({ name: `${d}-${m}-${f}`, ev: r.ev });
  }
  alts.sort((a, b) => b.ev - a.ev);
  const second = alts.find((a) => a.name !== shapeOf(cur.xi));
  const top = alts[0];
  if (!top || !second) return null;
  const margin = top.ev - second.ev;
  return {
    options: alts,
    text: margin < TOLERANCE
      ? `${shapeOf(cur.xi)} is the best shape your fifteen support, though ${second.name} is within ${margin.toFixed(2)} points — the shape is not what decides this week.`
      : `${shapeOf(cur.xi)} is the best shape your fifteen support, worth ${margin.toFixed(1)} more than ${second.name}.`,
  };
}

// ---------------------------------------------------------------------------
// Fixtures: swings, runs and the international break
// ---------------------------------------------------------------------------

/** Gameweeks preceded by a break of twelve days or more, from real kickoffs. */
export const BREAKS = DATA.model?.breaks || [];

/** Mean combined difficulty of a club's next `n` fixtures from index k. */
function runDifficulty(team, k, n) {
  const c = DATA.fdr[team]?.c || [];
  let t = 0, m = 0;
  for (let j = k; j < k + n && j < c.length; j++) {
    if (c[j] != null) { t += c[j]; m++; }
  }
  return m ? t / m : null;
}

/**
 * Which of your clubs are about to turn, and which way.
 *
 * A fixture swing is the reason to hold a player you would otherwise sell and
 * the reason to sell one who is scoring. It is computed per club you actually
 * own, because a league-wide "good fixtures from GW7" is not advice.
 */
export function fixtureSwings(squadIds, k, span = 6) {
  const clubs = [...new Set(squadIds.map((i) => byId[i]?.t).filter(Boolean))];
  const rows = [];
  for (const t of clubs) {
    const near = runDifficulty(t, k, 3);
    const later = runDifficulty(t, k + 3, 3);
    if (near == null || later == null) continue;
    const owned = squadIds.map((i) => byId[i]).filter((p) => p && p.t === t);
    rows.push({
      team: t, near, later, delta: near - later,   // positive = improving
      players: owned.map((p) => p.n),
      n: owned.length,
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const improving = rows.filter((r) => r.delta > 0.5);
  const worsening = rows.filter((r) => r.delta < -0.5);
  return { rows, improving, worsening };
}

/**
 * The next international break at or after this gameweek.
 *
 * Breaks matter to the optimisation because they are the one moment the game
 * gives you time: two clear weeks to see injuries resolve, price changes land
 * and a fixture run turn over. Restructuring INTO a break is cheap; making a
 * transfer the week before one, to fix a problem the break itself will clarify,
 * is the classic avoidable mistake.
 */
export function nextBreak(k) {
  const gw = DATA.gws[k];
  const after = BREAKS.filter((b) => b > gw).sort((a, b) => a - b)[0];
  if (after == null) return null;
  return { gw: after, weeksAway: after - gw, before: after - 1 };
}

// ---------------------------------------------------------------------------
// Transfers: act now, or plan ahead
// ---------------------------------------------------------------------------

/** Discounted horizon value of a squad, with each week's team sheet solved. */
function horizonEV(squadIds, ks, discount = 0.92) {
  let t = 0;
  ks.forEach((k, j) => {
    const s = pickTeam(squadIds, k);
    t += Math.pow(discount, j) * (s ? s.ev : gwScore(squadIds, k));
  });
  return t;
}

/**
 * Hold, use the free transfer, or take a hit — compared over the horizon, on
 * one scale, with the measured realisation factor applied to every gain.
 *
 * The separation the brief asks for is real and is enforced here: a move is
 * only ACT NOW if it pays inside the next two gameweeks. A transfer whose whole
 * case is a fixture swing three weeks out is PLAN AHEAD, because a free
 * transfer arrives every week and making it now spends the option early for
 * nothing.
 */
export function transferDecision(squadIds, k, { free = 1, span = 6 } = {}) {
  const ks = [];
  for (let j = k; j < Math.min(k + span, DATA.gws.length); j++) ks.push(j);
  const near = ks.slice(0, 2);

  const ideas = bestTransfers(squadIds, ks, 8);
  const base = horizonEV(squadIds, ks);
  const baseNear = horizonEV(squadIds, near);

  const scored = ideas.map((m) => {
    const next = squadIds.filter((i) => i !== m.out.i).concat([m.in.i]);
    const gain = (horizonEV(next, ks) - base) * REALISATION;
    const nearGain = (horizonEV(next, near) - baseNear) * REALISATION;
    return {
      ...m, gain, nearGain,
      // How much of the case rests on weeks you have not reached yet.
      deferred: gain > 0.01 ? Math.max(0, 1 - nearGain / gain) : 0,
      cost: m.in.c - m.out.c,
    };
  }).sort((a, b) => b.gain - a.gain);

  const best = scored[0] || null;
  const brk = nextBreak(k);

  // ACT NOW versus PLAN AHEAD.
  //
  // Only moves that clear the consider threshold are listed at all. A +0.1 swap
  // printed under a heading that says "worth doing this week" contradicts the
  // verdict directly above it, which reads as the page disagreeing with itself
  // — and the whole point of the tolerance layer is that a tenth of a point is
  // not a recommendation.
  const worth = scored.filter((m) => m.gain >= CONSIDER_THRESHOLD);
  const actNow = [], planAhead = [];
  for (const m of worth.slice(0, 5)) {
    (m.nearGain >= 1.0 || m.deferred < 0.55 ? actNow : planAhead).push(m);
  }

  // What holding is worth: a banked transfer is an option on next week's news.
  const rollValue = free >= 1 ? 1.0 : 0;
  const hitClears = best ? best.gain - 4 : -4;

  let verdict, headline, why = [];
  if (!best || best.gain < 0.8) {
    verdict = "ROLL";
    headline = free >= 1 ? "Roll your transfer" : "No change needed";
    why.push(best
      ? `The best move available is worth ${best.gain.toFixed(1)} points over ${ks.length} gameweeks — inside the model's own margin.`
      : "Nothing available improves this squad.");
    if (free >= 1) why.push("Keeping the transfer banked is worth more than spending it on a marginal upgrade — it buys you a free reaction to next week's news.");
  } else if (free >= 1 && best.gain >= 2.0 && best.nearGain >= 1.0) {
    verdict = "TRANSFER";
    headline = `${best.out.n} → ${best.in.n}`;
    why.push(`Worth ${best.gain.toFixed(1)} points over ${ks.length} gameweeks, ${best.nearGain.toFixed(1)} of it in the next two.`);
  } else if (free >= 1 && best.gain >= 2.0) {
    verdict = "WAIT";
    headline = `${best.out.n} → ${best.in.n}, but not yet`;
    why.push(`Worth ${best.gain.toFixed(1)} points, but only ${best.nearGain.toFixed(1)} of that lands in the next two gameweeks — the case is a fixture swing you have not reached.`);
    why.push("A free transfer arrives every week. Making this now spends the option early and buys nothing you cannot buy later.");
  } else if (free < 1 && hitClears > 2.0) {
    verdict = "HIT";
    headline = `${best.out.n} → ${best.in.n} (−4)`;
    why.push(`Worth ${best.gain.toFixed(1)} points against a certain 4-point cost — clears it by ${hitClears.toFixed(1)}.`);
  } else {
    verdict = "ROLL";
    headline = free >= 1 ? "Roll your transfer" : "Not worth a hit";
    why.push(free < 1
      ? `The best move gains ${best.gain.toFixed(1)} and a hit costs a certain 4. It does not clear.`
      : `Worth ${best.gain.toFixed(1)} — real, but not enough to spend a transfer that is more useful banked.`);
  }

  // The break is a genuine strategic input, so it is allowed to change the
  // verdict rather than merely being mentioned.
  if (brk && brk.weeksAway <= 2 && verdict === "TRANSFER" && best && best.gain < 3.0) {
    verdict = "WAIT";
    headline = `Hold — the break is ${brk.weeksAway === 1 ? "next week" : `${brk.weeksAway} weeks away`}`;
    why = [
      `The best move is worth ${best.gain.toFixed(1)} points, which is not enough to commit before an international break.`,
      `GW${brk.gw} follows a break: injuries resolve, prices settle and you get two weeks to restructure with better information.`,
    ];
  }

  // ROLLING IS AN OPTION, SO IT GETS A SCORE.
  //
  // The page used to name a move and leave rolling as the unstated default,
  // which makes "hold" look like the absence of a decision rather than a
  // decision. Both are priced on the same axis so they can be read against
  // each other: a move pays its gain and spends either the option value of a
  // banked transfer or a certain four points; rolling pays that option value
  // and gives up the gain.
  const moveCost = free >= 1 ? 1.0 : 4;
  const options = [
    {
      key: "MOVE",
      label: best ? `${best.out.n} → ${best.in.n}` : "No move available",
      net: best ? best.gain - moveCost : -Infinity,
      gain: best ? best.gain : 0,
      cost: moveCost,
      detail: best
        ? (free >= 1
            ? `Worth ${best.gain.toFixed(1)} over ${ks.length} weeks, against the 1.0 an unused transfer is worth as cover.`
            : `Worth ${best.gain.toFixed(1)}, against a certain 4-point hit.`)
        : "Nothing available improves this squad.",
      move: best || null,
    },
    {
      key: "ROLL",
      label: free >= 1 ? "Roll the transfer" : "Make no move",
      net: rollValue,
      gain: rollValue,
      cost: 0,
      detail: free >= 1
        ? "Banks the transfer. Worth about a point as an option on next week's news — an injury you can fix without paying for it."
        : "No free transfer banked, so holding costs nothing and risks nothing.",
      move: null,
    },
  ].sort((a, b) => b.net - a.net);

  return {
    verdict, headline, why,
    best, all: scored, actNow, planAhead,
    rollValue, hitClears, free,
    options,
    weeks: ks.map((j) => DATA.gws[j]),
    brk,
  };
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/**
 * BENCH BOOST, AND THE MISTAKE IT INVITES
 * ---------------------------------------
 * A Free Hit squad is a one-week squad: you hand it back, so nothing after the
 * chip week counts. A Bench Boost squad is NOT — you keep it. Optimising one
 * the way you optimise the other is the actual bug, and it is a conceptual one
 * rather than an arithmetic one.
 *
 * MEASURED, on GW1 at a £100m budget:
 *
 *   objective          bench £   GW1(BB)   GW2-6    total
 *   one week only        21.5      78.8    280.7    359.5
 *   six weeks            22.0      76.4    288.7    365.1
 *   no chip at all       20.0      72.5    291.1    363.6
 *
 * The one-week objective buys 2.4 more points in the chip week and gives up 8.0
 * over the five weeks after it. That is the failure exactly as described, and
 * it is worth 5.6 points.
 *
 * TWO THINGS THE OBVIOUS FIX GETS WRONG, both measured:
 *
 * 1. It is NOT about money on the bench. The naive squad spends £21.5m on its
 *    bench and the sound one spends £22.0m — the expensive-bench squad is the
 *    BETTER one. Capping bench spend would have made this worse, which is why
 *    no bench budget is hardcoded anywhere in this file.
 *
 * 2. "Money trapped on the bench" points the wrong way too. Trapped money —
 *    players who never start again over the horizon — is £0.0m in the naive
 *    squad, £4.5m in the sound one and £9.0m in the no-chip squad, which is
 *    the strongest of the three from GW2 onward. It is reported below because
 *    it is a fair thing to show a manager, but it is deliberately NOT part of
 *    the objective, because on this data it would select backwards.
 *
 * What separates them is neither: it is whether the bench players are people
 * you would want to own anyway. The naive squad benches four players picked for
 * one Saturday; the sound one benches Virgil van Dijk, who starts four of the
 * next five. So the term that actually works is the one below — how far the
 * squad falls short of a free rebuild over the weeks AFTER the chip, and how
 * many transfers it would take to close that gap.
 */
export function benchBoostPlan(squadIds, k, { span = 6, budget = BUDGET } = {}) {
  const after = [];
  for (let j = k + 1; j < Math.min(k + span, DATA.gws.length); j++) after.push(j);

  const build = (weeks) => optimise({ weeks, budget });
  const naive = build(chipWeeks(k, 1, k, "bb", "flat"));
  const sound = build(chipWeeks(k, Math.max(span, 2), k, "bb", "flat"));

  const rate = (r) => {
    if (!r?.feasible) return null;
    const chipWeek = weekScore(r.squad, k, { bb: true }).pts;
    let tail = 0;
    for (const j of after) tail += weekScore(r.squad, j).pts;
    return { ...r, chipWeek, tail, total: chipWeek + tail };
  };

  return {
    naive: rate(naive),
    sound: rate(sound),
    after: after.map((j) => DATA.gws[j]),
    // The charge against the naive build, which is the one that needs it.
    restructure: naive?.feasible ? restructureValue(naive.ids, k, span) : null,
    soundRestructure: sound?.feasible ? restructureValue(sound.ids, k, span) : null,
  };
}

/**
 * What it costs to live with this squad once the chip is spent.
 *
 * Five components, all of which the brief asks for. Two of them are reported
 * and not weighted, for the measured reasons above — showing a manager a number
 * that would select backwards if believed is worse than not showing it, so each
 * one says which it is.
 */
export function restructureValue(squadIds, k, span = 6) {
  const after = [];
  for (let j = k + 1; j < Math.min(k + span, DATA.gws.length); j++) after.push(j);
  if (!after.length) return null;

  // FUTURE FIXTURE VALUE — what this squad scores over the weeks after the
  // chip, against what an unconstrained rebuild would score. This is the term
  // that carries the signal, so it is the one the objective uses.
  const ideal = optimise({ weeks: wildcardWeeks(after[0], after.length, "decay") });
  let mine = 0, best = 0;
  for (const j of after) {
    mine += weekScore(squadIds.map((i) => byId[i]).filter(Boolean), j).pts;
    best += weekScore(ideal.squad, j).pts;
  }
  const gap = best - mine;

  // TRANSFER REQUIREMENT — how many moves stand between the two.
  const overlap = squadIds.filter((i) => ideal.ids.includes(i)).length;
  const transfers = 15 - overlap;

  // MONEY AVAILABLE FOR THE XI, and MONEY TRAPPED ON THE BENCH. Both reported,
  // neither weighted: measured against three GW1 squads, bench spend separated
  // them by £2m in the wrong direction and trapped money ranked them exactly
  // backwards. See the comment on benchBoostPlan.
  const players = squadIds.map((i) => byId[i]).filter(Boolean);
  const sheet = weekScore(players, k);
  const benchSpend = sheet.bench.reduce((s, p) => s + p.c, 0);
  const xiSpend = sheet.xi.reduce((s, p) => s + p.c, 0);
  const benchIds = new Set(sheet.bench.map((p) => p.i));
  const startsAgain = new Set();
  for (const j of after) {
    for (const p of weekScore(players, j).xi) if (benchIds.has(p.i)) startsAgain.add(p.i);
  }
  const trapped = sheet.bench.filter((p) => !startsAgain.has(p.i))
    .reduce((s, p) => s + p.c, 0);

  // SQUAD FLEXIBILITY — money in the bank plus how many players are sellable
  // without breaking the side.
  const inBank = BUDGET - squadCost(squadIds);

  return {
    gap, transfers, benchSpend, xiSpend, trapped, inBank,
    weeks: after.map((j) => DATA.gws[j]),
    // The charge against a chip strategy: the horizon it gives up, plus the
    // transfers needed to recover, valued at what a transfer is worth.
    cost: gap + Math.max(0, transfers - 2) * 0.5,
    weighted: ["future fixture value", "transfer requirement"],
    reported: ["money on the bench", "money trapped on the bench", "money in the bank"],
  };
}

/**
 * Every chip, valued on the squad you actually hold, each with the objective
 * that chip deserves.
 *
 *   Bench Boost     all fifteen score, but you KEEP the squad — so the value is
 *                   the chip week minus what the squad gives up afterwards.
 *   Triple Captain  ceiling and minutes security, not the mean: a tripled
 *                   captain who does not play is the worst outcome in the game.
 *   Free Hit        the one week, entirely. Nothing after it counts.
 *   Wildcard        the long horizon, and worth most into a break.
 */
export function chipPlans(squadIds, k, { span = 6, spent = [], squadAt = null } = {}) {
  // `squadAt(j)` is the fifteen the PLAN leaves you with in week j. A bench
  // boost is only as good as the bench you will actually own by then, so a
  // transfer locked in for GW3 has to move GW3's chip value — otherwise the
  // plan bar keeps quoting a team you have already decided to change.
  const at = (j) => (squadAt ? (squadAt(j) || squadIds) : squadIds);
  const players = squadIds.map((i) => byId[i]).filter(Boolean);
  const ks = [];
  for (let j = k; j < Math.min(k + span, DATA.gws.length); j++) ks.push(j);
  const out = {};

  if (!spent.includes("bb")) {
    const rows = ks.map((j) => {
      const sheet = pickTeam(at(j), j);
      const bench = sheet ? sheet.bench.reduce((s, p) => s + p.g[j], 0) : 0;
      const playing = sheet ? sheet.bench.filter((p) => pPlay(p) > 0.5).length : 0;
      return { k: j, gw: DATA.gws[j], gain: bench, playing };
    }).sort((a, b) => b.gain - a.gain);
    const top = rows[0];
    out.bb = {
      title: "Bench Boost", rows,
      best: top,
      worth: top && top.gain >= 12,
      why: top
        ? `Your bench is worth ${top.gain.toFixed(1)} points in GW${top.gw}, with ${top.playing} of the four likely to start. ${top.gain >= 12 ? "That clears the bar for playing it." : "Below the 12 points a Bench Boost is worth waiting for."}`
        : "",
      note: "Valued on the bench you will own, not on a bench built to be boosted — building for the chip costs more over the following weeks than it gains in it.",
    };
  }

  if (!spent.includes("tc")) {
    const rows = ks.map((j) => {
      const sheet = pickTeam(at(j), j);
      const c = sheet?.capt;
      return {
        k: j, gw: DATA.gws[j],
        gain: c ? c.g[j] : 0,
        // A tripled armband is a bet on one player appearing. Ceiling and
        // security are what separate the weeks, not the mean.
        adjusted: c ? c.g[j] * pPlay(c) * (1 + 0.5 * (c.h10 ?? 0)) : 0,
        player: c,
      };
    }).sort((a, b) => b.adjusted - a.adjusted);
    const top = rows[0];
    out.tc = {
      title: "Triple Captain", rows, best: top,
      worth: top && top.gain >= 8,
      why: top?.player
        ? `${top.player.n} in GW${top.gw}: ${top.gain.toFixed(1)} projected, ${Math.round(pPlay(top.player) * 100)}% to play, ${Math.round((top.player.h10 ?? 0) * 100)}% chance of a double-figure haul.`
        : "",
      note: "Ranked on ceiling and minutes security rather than the mean — a tripled captain who does not play is the worst single outcome available to you.",
    };
  }

  if (!spent.includes("fh")) {
    const rows = ks.map((j) => ({
      k: j, gw: DATA.gws[j],
      gain: Math.max(0, (OPTIMAL[String(DATA.gws[j])]?.xp ?? 0) - gwScore(at(j), j)),
    })).sort((a, b) => b.gain - a.gain);
    const top = rows[0];
    out.fh = {
      title: "Free Hit", rows, best: top,
      worth: top && top.gain >= 15,
      why: top ? `A perfect one-week squad beats yours by ${top.gain.toFixed(1)} in GW${top.gw}.` : "",
      note: "The only chip optimised for a single week, because it is the only one where you hand the squad back afterwards.",
    };
  }

  if (!spent.includes("wc")) {
    const rows = ks.map((j) => {
      const rest = [];
      for (let x = j; x < Math.min(j + span, DATA.gws.length); x++) rest.push(x);
      const ideal = OPTIMAL.range?.squad;
      let gain = 0;
      for (const x of rest) gain += (gwScore(ideal, x) - gwScore(at(j), x));
      const brk = BREAKS.includes(DATA.gws[j]);
      return { k: j, gw: DATA.gws[j], gain: gain * REALISATION, brk };
    }).sort((a, b) => b.gain - a.gain);
    const top = rows[0];
    out.wc = {
      title: "Wildcard", rows, best: top,
      worth: top && top.gain >= 6,
      why: top
        ? `A full rebuild is worth ${top.gain.toFixed(1)} realised points from GW${top.gw}.${top.brk ? " That week follows an international break, which is when a rebuild is worth most — you get two weeks of resolved injuries and settled prices to build against." : ""}`
        : "",
      note: "Optimised over the long horizon, because a wildcard squad is one you intend to keep.",
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// The roadmap
// ---------------------------------------------------------------------------

/**
 * GW1 → GW6, with only what changes a decision on each week.
 *
 * Deliberately thin. A roadmap that lists everything is a spreadsheet, and the
 * point of it is to communicate a plan at a glance.
 */
export function roadmap(squadIds, k, { span = 6, free = 1, spent = [] } = {}) {
  const rows = [];
  const chips = chipPlans(squadIds, k, { span, spent });
  const swings = fixtureSwings(squadIds, k, span);

  for (let j = k; j < Math.min(k + span, DATA.gws.length); j++) {
    const sheet = pickTeam(squadIds, j);
    const gw = DATA.gws[j];
    const isBreak = BREAKS.includes(gw);

    // The one chip worth mentioning for this week, if any.
    let chip = null;
    for (const [key, c] of Object.entries(chips)) {
      if (c?.worth && c.best?.gw === gw) {
        chip = { key, title: c.title, gain: c.best.gain };
        break;
      }
    }

    // Clubs whose run turns this week.
    const turning = swings.rows.filter((r) => {
      const near = runDifficulty(r.team, j, 2);
      const prev = runDifficulty(r.team, Math.max(0, j - 2), 2);
      return near != null && prev != null && Math.abs(prev - near) > 0.8;
    }).slice(0, 2);

    rows.push({
      k: j, gw,
      pts: sheet ? sheet.ev : gwScore(squadIds, j),
      capt: sheet?.capt || null,
      formation: sheet?.formation || null,
      isBreak,
      chip,
      swing: turning.map((t) => ({
        team: t.team,
        dir: t.delta > 0 ? "easier" : "harder",
        players: t.players,
      })),
      // Free transfers accumulate if you roll — shown so the plan is legible.
      ft: Math.min(5, free + (j - k)),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// How good is this, really?
// ---------------------------------------------------------------------------

/**
 * A score out of 100 is worthless without its anchors.
 *
 * "72/100" tells a manager nothing: is that a fine team or a broken one? It
 * depends entirely on how harshly the thing is marked, and no amount of
 * staring at the number reveals that. So this returns the two reference points
 * along with the score, and the UI shows them on the same scale:
 *
 *     50   the TEMPLATE — the most-owned legal fifteen, which is very nearly
 *          what the median manager fields. Average by construction.
 *    100   the CEILING — the best eleven available at your budget that week.
 *
 * Below 50 is possible and is meant to be: a squad worse than the template is
 * a real thing and the scale should say so rather than flooring at zero.
 *
 * Scored on the ELEVEN, not the fifteen, because that is what actually scores
 * points this week. Fixtures are already inside the projection — a kind
 * fixture raises `p.g[k]` — so difficulty is reported beside the score rather
 * than added to it, which would pay for the same thing twice.
 */
export function weekQuality(squadIds, k) {
  const players = squadIds.map((i) => byId[i]).filter(Boolean);
  if (players.length < 11) return null;

  const sheet = pickTeam(squadIds, k);
  if (!sheet) return null;

  const ceilingPts = OPTIMAL[String(DATA.gws[k])]?.xp ?? null;
  const tmpl = templateSquad();
  const field = tmpl ? weekScore(tmpl, k).pts : null;
  const mine = weekScore(players, k).pts;

  let score = null;
  if (field != null && ceilingPts != null && ceilingPts > field) {
    score = Math.max(0, Math.min(100, 50 + 50 * ((mine - field) / (ceilingPts - field))));
  }

  // The XI's fixture difficulty, averaged. Reported, not scored.
  let fdrTotal = 0, fdrN = 0;
  for (const p of sheet.xi) {
    const f = fixtureAt(p.t, k);
    if (f && f.fdr != null) { fdrTotal += f.fdr; fdrN++; }
  }
  const fdr = fdrN ? fdrTotal / fdrN : null;

  return {
    score: score == null ? null : Math.round(score),
    pts: mine, field, ceiling: ceilingPts,
    gw: DATA.gws[k],
    formation: sheet.formation,
    fdr,
    // What the number MEANS, in points rather than in marks out of a hundred.
    vsField: field == null ? null : mine - field,
    vsCeiling: ceilingPts == null ? null : mine - ceilingPts,
    band: score == null ? null : qualityBandOf(score),
  };
}

export const qualityBandOf = (s) =>
  s >= 88 ? { label: "ELITE", c: "#00FF87" }
  : s >= 72 ? { label: "STRONG", c: "#8BE24A" }
  : s >= 56 ? { label: "SOLID", c: "#F5C542" }
  : s >= 42 ? { label: "AVERAGE", c: "#F5772E" }
  : { label: "BEHIND", c: "#E90052" };

// ---------------------------------------------------------------------------
// The season plan, in one line per decision
// ---------------------------------------------------------------------------

/**
 * THE ANSWER TO "WHAT IS MY PLAN?"
 *
 * Each chip gets ONE recommended week across the whole run, and the transfer
 * call gets one line. That is the entire output, and the restraint is the
 * point: the app used to re-derive "Wildcard now" every single gameweek and
 * present it as fresh news, which is how a one-shot asset ends up being
 * recommended eight weeks running. A chip you are told to play every week is a
 * chip you are being told nothing about.
 *
 * `spent` is the chips you have already used. They vanish rather than being
 * scored, because there is no decision left in them.
 */
export function seasonStrategy(squadIds, k, {
  free = 1, spent = [], span = 12, planWeeks = null,
} = {}) {
  if (!squadIds || squadIds.length !== 15) return null;
  const end = Math.min(k + span, DATA.gws.length);
  const ks = [];
  for (let j = k; j < end; j++) ks.push(j);

  // `planWeeks` is the resolved season plan. When it is supplied, each week's
  // chip is valued on the squad the plan LEAVES you with that week rather than
  // on today's fifteen — so locking a transfer in GW3 immediately moves GW3's
  // bench boost and triple captain numbers up here, which is the whole point of
  // committing to it.
  const squadAt = planWeeks
    ? (j) => planWeeks[j]?.squad || squadIds
    : null;
  const chips = chipPlans(squadIds, k, { span: ks.length, spent, squadAt });
  const t = transferDecision(squadIds, k, { free, span: 6 });
  const brk = nextBreak(k);

  // One row per chip, each naming a single week and saying how firmly.
  const rows = [];
  for (const [key, c] of Object.entries(chips)) {
    if (!c || !c.best) continue;
    const runnerUp = c.rows[1]?.gain ?? 0;
    const margin = (c.best.gain ?? 0) - runnerUp;
    rows.push({
      key, title: c.title,
      gw: c.best.gw,
      gain: c.best.gain,
      worth: c.worth,
      // A week is only worth committing to if it clearly beats the next-best.
      // Otherwise the honest answer is a region, not a date.
      firm: c.worth && margin >= 1.5,
      near: c.rows.slice(0, 3).map((r) => r.gw).sort((a, b) => a - b),
      why: c.why,
      player: c.best.player || null,
    });
  }
  rows.sort((a, b) => (b.worth - a.worth) || a.gw - b.gw);

  return {
    gw: DATA.gws[k],
    chips: rows,
    transfer: {
      verdict: t.verdict, headline: t.headline, why: t.why, best: t.best,
      // Forwarded, not re-derived: the plan bar prices move against roll and
      // must use the same numbers the verdict was reached with.
      options: t.options,
    },
    free,
    brk,
    // Rolling: how many transfers you will have banked if you hold from here.
    banked: Math.min(5, free),
  };
}

// ---------------------------------------------------------------------------
// The briefing — everything the page needs, in one call
// ---------------------------------------------------------------------------

/**
 * What the manager decided, and why.
 *
 * One entry point so the UI never assembles a recommendation itself: if two
 * panels disagree it is because they were given different questions, and the
 * only reliable way to stop that is for there to be one answer object.
 */
export function managerBriefing(squadIds, k, {
  free = 1, captId = null, lockXI = null, span = 6, spent = [], chip = null,
} = {}) {
  if (!squadIds || squadIds.length !== 15) return null;

  const sheet = pickTeam(squadIds, k, {
    captId, lockXI, bb: chip === "bb", tc: chip === "tc",
  });
  if (!sheet) return null;

  const transfers = transferDecision(squadIds, k, { free, span });
  const chips = chipPlans(squadIds, k, { span, spent });
  const plan = roadmap(squadIds, k, { span, free, spent });
  const swings = fixtureSwings(squadIds, k, span);
  const brk = nextBreak(k);

  // The verdict, in the manager's voice. Transfers lead because that is the
  // decision with a deadline; everything else is the team sheet, which the
  // page has already shown.
  const verdict = {
    call: transfers.verdict,
    headline: transfers.headline,
    why: transfers.why,
  };

  // One line that ties it together, which is what a manager would actually say.
  const strong = sheet.ev >= 55;
  const lines = [];
  if (transfers.verdict === "ROLL") {
    lines.push(strong
      ? `Roll your transfer. Your eleven already projects ${sheet.ev.toFixed(0)} and nothing available beats holding the flexibility.`
      : `Roll your transfer. Nothing available is worth more than a banked move you can spend on better information next week.`);
  } else if (transfers.verdict === "WAIT") {
    lines.push(`Hold this week. ${transfers.best ? `${transfers.best.out.n} → ${transfers.best.in.n} is the right move eventually, but its value is in weeks you have not reached.` : ""}`);
  } else if (transfers.verdict === "TRANSFER") {
    lines.push(`Make the move: ${transfers.headline}. It pays in the next two gameweeks rather than in a fixture swing you are guessing at.`);
  } else if (transfers.verdict === "HIT") {
    lines.push(`Worth the hit: ${transfers.headline}.`);
  }
  if (brk && brk.weeksAway <= 3) {
    lines.push(`GW${brk.gw} follows an international break — that is your restructuring window, not this week.`);
  }
  const liveChip = Object.entries(chips).find(([, c]) => c?.worth && c.best?.gw === DATA.gws[k]);
  if (liveChip) lines.push(`${liveChip[1].title} is at its best week of the range now.`);

  return {
    gw: DATA.gws[k], k,
    sheet, transfers, chips, plan, swings, brk,
    verdict,
    summary: lines.slice(0, 3),
    // Confidence: how clearly the recommendation beats the alternative, damped
    // by how far ahead the model is being asked to see.
    confidence: Math.max(0.5, Math.min(0.92,
      0.6 + (transfers.best ? Math.min(0.25, Math.abs(transfers.best.gain) / 12) : 0.1)
      - Math.max(0, span - 4) * 0.015)),
  };
}
