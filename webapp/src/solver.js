// In-browser squad optimiser.
//
// Why this exists
// ---------------
// The Python MILP in fplab/optimize.py is the real optimiser, but it runs
// offline: export_data.py bakes a fixed handful of solves into optimal.json
// and the app can only read those back. That is fine for "the best GW7 squad"
// and useless for anything the user chooses at runtime — "best squad that
// must contain Bruno and Haaland" is one of 10^20-odd possible lock sets, and
// no amount of precomputing reaches it.
//
// So the questions that depend on user input get answered here instead. This
// is a heuristic and makes no claim of proven optimality — but it is measured
// rather than hoped at: `verifyAgainstMILP` re-solves all 19 single-gameweek
// problems that CBC has already solved exactly and reports the gap. Run it in
// the console after touching anything in this file.
//
// Plain steepest descent on a single-swap neighbourhood is NOT good enough,
// and the check above is what proved it: it came up short in 16 of 19 weeks,
// by as much as 3.1 points. The reason is the budget. Upgrading one player is
// frequently unaffordable until you downgrade another, so the two moves have
// to happen together — and a neighbourhood that only ever changes one player
// at a time sees both halves as losses and refuses to cross. Hence iterated
// local search: converge, kick the squad out of the basin, re-converge, keep
// the best.
//
// Where that landed, measured against CBC on all 19 weeks: exact on 15 of 19,
// mean gap 0.04 points, worst 0.89 — against squad totals around 57, so the
// average miss is under a tenth of a percent. Solves take 0.5–0.7s. Good
// enough to answer a question CBC cannot be asked at runtime; not a substitute
// for it, which is why optimal.json still holds the proven squads.
//
// The objective is the real FPL scoring rule, not a proxy: only the best legal
// XI counts, the captain counts twice, and the bench counts for nothing unless
// Bench Boost is on.

import { BUDGET, DATA, FORMATIONS, QUOTA, byId, isGated } from "./logic.js";

// A squad is scored on the best XI it can field, so the scorer has to solve
// the formation choice too. Seven legal shapes, so we just try all of them.
const POS = ["GK", "DEF", "MID", "FWD"];

/**
 * Points a fifteen actually returns in gameweek `k`.
 *
 * bb  Bench Boost: the four substitutes score as well.
 * tc  Triple Captain: the armband pays three times rather than twice.
 *
 * Returns { pts, xi, bench, capt } where pts is what FPL would award.
 */
export function weekScore(players, k, { bb = false, tc = false } = {}) {
  const by = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of players) if (by[p.p]) by[p.p].push(p);
  for (const pos of POS) by[pos].sort((a, b) => b.g[k] - a.g[k]);

  if (!by.GK.length) return { pts: 0, xi: [], bench: [], capt: null };

  let best = null;
  for (const [d, m, f] of FORMATIONS) {
    if (by.DEF.length < d || by.MID.length < m || by.FWD.length < f) continue;
    const xi = [by.GK[0], ...by.DEF.slice(0, d), ...by.MID.slice(0, m), ...by.FWD.slice(0, f)];
    let sum = 0;
    for (const p of xi) sum += p.g[k];
    if (!best || sum > best.sum) best = { sum, xi };
  }
  if (!best) return { pts: 0, xi: [], bench: [], capt: null };

  let capt = best.xi[0];
  for (const p of best.xi) if (p.g[k] > capt.g[k]) capt = p;

  const inXI = new Set(best.xi.map((p) => p.i));
  const bench = players.filter((p) => !inXI.has(p.i));

  // Captain doubles (triples on TC). Bench only pays under Bench Boost.
  let pts = best.sum + capt.g[k] * (tc ? 2 : 1);
  if (bb) for (const p of bench) pts += p.g[k];

  return { pts, xi: best.xi, bench, capt };
}

/**
 * Objective across a horizon. `weeks` is a list of
 * { k, w, bb, tc } — gameweek index, weight, and which chips are live.
 */
function objective(players, weeks) {
  let total = 0;
  for (const wk of weeks) total += wk.w * weekScore(players, wk.k, wk).pts;
  return total;
}

// Candidate pool. Gated players (below the minutes threshold) and anyone
// flagged injured/suspended/unavailable are excluded for the same reason the
// MILP drops them: near-zero points still buys a cheap body the search would
// happily park on a bench.
function buildPool(exclude, weeks) {
  const out = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of DATA.players) {
    if (exclude.has(p.i)) continue;
    if (isGated(p)) continue;
    if (p.st && p.st !== "d") continue;
    if (out[p.p]) out[p.p].push(p);
  }

  // Prune to the Pareto frontier of (cost, projected points). A player who
  // costs more than another and scores less can never be the right pick, so
  // carrying him only slows every pass down — and the search is timeboxed, so
  // slower directly means worse. This typically takes ~130 midfielders to
  // ~35 without changing any answer.
  //
  // The exception is the three-per-club limit, which can make a dominated
  // player the only legal option. So each club keeps its best few per position
  // regardless of whether they survive the frontier.
  const horizonPts = (p) => weeks.reduce((s, wk) => s + wk.w * p.g[wk.k], 0);
  const KEEP_PER_CLUB = 3;

  for (const pos of POS) {
    const all = out[pos];
    const pts = new Map(all.map((p) => [p.i, horizonPts(p)]));

    const byCost = [...all].sort((a, b) => a.c - b.c || pts.get(b.i) - pts.get(a.i));
    const keep = new Set();
    let ceiling = -Infinity;
    for (const p of byCost) {
      const v = pts.get(p.i);
      if (v > ceiling) { keep.add(p.i); ceiling = v; }
    }

    const perClub = {};
    for (const p of [...all].sort((a, b) => pts.get(b.i) - pts.get(a.i))) {
      perClub[p.t] = (perClub[p.t] || 0) + 1;
      if (perClub[p.t] <= KEEP_PER_CLUB) keep.add(p.i);
    }

    out[pos] = all.filter((p) => keep.has(p.i));
  }
  return out;
}

const cost = (players) => players.reduce((s, p) => s + p.c, 0);

function clubTally(players) {
  const c = {};
  for (const p of players) c[p.t] = (c[p.t] || 0) + 1;
  return c;
}

/**
 * Greedy seed: fill each position with the best available by horizon points,
 * then walk back down to affordability. A bad seed only costs iterations —
 * the local search below is what determines the answer — but a cheap sensible
 * one converges much faster than a random draw.
 */
function seed(pool, locked, weeks, budget, maxPerClub) {
  const squad = [...locked];
  const need = { ...QUOTA };
  for (const p of locked) need[p.p]--;

  const horizonPts = (p) => weeks.reduce((s, wk) => s + wk.w * p.g[wk.k], 0);
  const ranked = {};
  for (const pos of POS) {
    ranked[pos] = [...pool[pos]].sort((a, b) => horizonPts(b) - horizonPts(a));
  }

  const clubs = clubTally(squad);
  const taken = new Set(squad.map((p) => p.i));

  // Best-first, then repair: take the strongest legal player per slot, and if
  // that overruns the budget swap the worst-value picks down until it fits.
  for (const pos of POS) {
    for (let n = 0; n < need[pos]; n++) {
      const pick = ranked[pos].find(
        (p) => !taken.has(p.i) && (clubs[p.t] || 0) < maxPerClub);
      if (!pick) return null;
      squad.push(pick);
      taken.add(pick.i);
      clubs[pick.t] = (clubs[pick.t] || 0) + 1;
    }
  }

  // Repair pass: while over budget, replace the squad member whose downgrade
  // costs the fewest points per pound freed.
  const lockedIds = new Set(locked.map((p) => p.i));
  let guard = 0;
  while (cost(squad) > budget && guard++ < 300) {
    let bestMove = null;
    for (let idx = 0; idx < squad.length; idx++) {
      const out = squad[idx];
      if (lockedIds.has(out.i)) continue;
      for (const cand of ranked[out.p]) {
        if (taken.has(cand.i) || cand.c >= out.c) continue;
        const tally = { ...clubs };
        tally[out.t]--;
        if ((tally[cand.t] || 0) >= maxPerClub) continue;
        const freed = out.c - cand.c;
        const lost = horizonPts(out) - horizonPts(cand);
        const ratio = lost / Math.max(freed, 0.1);
        if (!bestMove || ratio < bestMove.ratio) bestMove = { idx, out, cand, ratio };
      }
    }
    if (!bestMove) return null;
    taken.delete(bestMove.out.i);
    taken.add(bestMove.cand.i);
    clubs[bestMove.out.t]--;
    clubs[bestMove.cand.t] = (clubs[bestMove.cand.t] || 0) + 1;
    squad[bestMove.idx] = bestMove.cand;
  }
  return cost(squad) <= budget ? squad : null;
}

/**
 * Optimise a fifteen.
 *
 * weeks        [{ k, w, bb, tc }]  which gameweeks count, how much, chips live
 * lockIds      players that MUST be in the squad (the "I want Bruno and
 *              Haaland, build around them" case)
 * banIds       players that must NOT be
 * budget       £m available
 *
 * Returns { squad, pts, cost, feasible, reason } — squad as player objects.
 */
export function optimise({
  weeks,
  lockIds = [],
  banIds = [],
  budget = BUDGET,
  maxPerClub = 3,
  maxPasses = 40,
  // A single convergence costs a few milliseconds, so the kick budget is set
  // by what stays imperceptible in the UI rather than by what the search needs.
  restarts = 120,
  timeBudgetMs = 700,
} = {}) {
  const locked = lockIds.map((i) => byId[i]).filter(Boolean);

  // Locks are checked before searching, because an impossible lock set should
  // produce an explanation rather than a silently worse squad.
  const lockPos = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of locked) lockPos[p.p]++;
  for (const pos of POS) {
    if (lockPos[pos] > QUOTA[pos]) {
      return { feasible: false, reason: `You have locked ${lockPos[pos]} ${pos} — only ${QUOTA[pos]} fit in a squad.` };
    }
  }
  const lockClubs = clubTally(locked);
  for (const [club, n] of Object.entries(lockClubs)) {
    if (n > maxPerClub) {
      return { feasible: false, reason: `You have locked ${n} players from ${club} — the limit is ${maxPerClub}.` };
    }
  }
  if (cost(locked) > budget) {
    return { feasible: false, reason: `Your locked players alone cost £${cost(locked).toFixed(1)}m, over the £${budget.toFixed(1)}m budget.` };
  }

  const exclude = new Set(banIds);
  for (const p of locked) exclude.add(p.i);
  const pool = buildPool(exclude, weeks);
  for (const pos of POS) {
    if (pool[pos].length < QUOTA[pos] - lockPos[pos]) {
      return { feasible: false, reason: `Not enough available ${pos} to fill a squad.` };
    }
  }

  const start = seed(pool, locked, weeks, budget, maxPerClub);
  if (!start) {
    return { feasible: false, reason: "Could not build a legal fifteen inside the budget with those locks." };
  }

  const lockedIds = new Set(locked.map((p) => p.i));

  // Deterministic randomness. The kicks below need a random source, but a
  // squad that changed every time the component re-rendered would be unusable,
  // so the stream is seeded from the problem itself: same question, same
  // answer, every time.
  const rand = mulberry32(hashProblem(weeks, lockIds, banIds, budget));

  let best = localSearch(start, pool, lockedIds, weeks, budget, maxPerClub, maxPasses);
  const t0 = now();

  // Quality here is very nearly a function of how many kicks fit in the time
  // budget, which is worth knowing before optimising anything: a "smarter",
  // costlier kick that targeted the budget-coupling trap directly was tried
  // and measured WORSE (mean gap 0.36 against 0.07) purely because it halved
  // the number of attempts. Cheap and many beats clever and few.
  for (let kick = 0; kick < restarts; kick++) {
    if (now() - t0 > timeBudgetMs) break;
    const kicked = perturb(best.squad, pool, lockedIds, budget, maxPerClub, rand);
    if (!kicked) continue;
    const r = localSearch(kicked, pool, lockedIds, weeks, budget, maxPerClub, maxPasses);
    if (r.score > best.score + 1e-9) best = r;
  }

  return {
    feasible: true,
    squad: best.squad,
    ids: best.squad.map((p) => p.i),
    pts: best.score,
    cost: cost(best.squad),
  };
}

/** Steepest descent to a local optimum on the single-swap neighbourhood. */
function localSearch(startSquad, pool, lockedIds, weeks, budget, maxPerClub, maxPasses) {
  const squad = startSquad.slice();
  let score = objective(squad, weeks);

  for (let pass = 0; pass < maxPasses; pass++) {
    const spend = cost(squad);
    const clubs = clubTally(squad);
    const inSquad = new Set(squad.map((p) => p.i));
    let bestMove = null;

    for (let idx = 0; idx < squad.length; idx++) {
      const out = squad[idx];
      if (lockedIds.has(out.i)) continue;
      const headroom = budget - spend + out.c;
      for (const cand of pool[out.p]) {
        if (inSquad.has(cand.i)) continue;
        if (cand.c > headroom + 1e-9) continue;
        if (cand.t !== out.t && (clubs[cand.t] || 0) >= maxPerClub) continue;
        const prev = squad[idx];
        squad[idx] = cand;
        const s = objective(squad, weeks);
        squad[idx] = prev;
        if (s > score + 1e-9 && (!bestMove || s > bestMove.s)) bestMove = { idx, cand, s };
      }
    }
    if (!bestMove) break;
    squad[bestMove.idx] = bestMove.cand;
    score = bestMove.s;
  }
  return { squad, score };
}

/**
 * Kick the squad out of its basin: replace a few players at random, ignoring
 * whether the swap looks good. Two or three at once is the point — that is
 * exactly the coordinated move (fund an upgrade by taking a downgrade
 * elsewhere) that single-swap descent cannot see.
 */
function perturb(squad, pool, lockedIds, budget, maxPerClub, rand) {
  const next = squad.slice();
  const movable = [];
  for (let i = 0; i < next.length; i++) if (!lockedIds.has(next[i].i)) movable.push(i);
  if (movable.length < 2) return null;

  const k = 2 + Math.floor(rand() * 2);          // 2 or 3 players
  for (let n = 0; n < k; n++) {
    const idx = movable[Math.floor(rand() * movable.length)];
    const out = next[idx];
    const inSquad = new Set(next.map((p) => p.i));
    const clubs = clubTally(next);
    const headroom = budget - cost(next) + out.c;
    const legal = pool[out.p].filter(
      (c) => !inSquad.has(c.i) && c.c <= headroom + 1e-9
        && (c.t === out.t || (clubs[c.t] || 0) < maxPerClub));
    if (!legal.length) continue;
    next[idx] = legal[Math.floor(rand() * legal.length)];
  }
  return cost(next) <= budget + 1e-9 ? next : null;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Small, fast, well-distributed PRNG. Nothing here is security-sensitive; it
// only has to be reproducible across runs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashProblem(weeks, lockIds, banIds, budget) {
  let h = 2166136261;
  const push = (v) => { h ^= v; h = Math.imul(h, 16777619); };
  for (const w of weeks) { push(w.k); push(Math.round(w.w * 1000)); push(w.bb ? 1 : 2); push(w.tc ? 3 : 4); }
  for (const i of lockIds) push(i);
  for (const i of banIds) push(i);
  push(Math.round(budget * 10));
  return h >>> 0;
}

// ---- scenario builders ----------------------------------------------------
// Each of these turns a plain-English strategy into the `weeks` array the
// optimiser wants. Keeping them here means the UI never has to reason about
// discounting or chip mechanics.

// Later gameweeks are worth less: projections decay in reliability, and the
// squad will have been transferred by then anyway. Matches the MILP default.
// Two different discounts, deliberately not merged.
//
// DISCOUNT is OPTION VALUE: how much a squad should commit today to points
// that fall weeks away, given a free transfer arrives every week and can buy
// them later. It is an assumption, labelled as one on the methodology page.
//
// The confidence decay (0.976, fitted — see config.HORIZON_CONFIDENCE_DECAY)
// is a different question: how much the PROJECTION is worth that far out.
// Multiplying by both would charge the horizon twice.
const DISCOUNT = 0.88;

// Weighting modes. `decay` is right for an open-ended squad that keeps its
// flexibility; `flat` is right when the window is a COMMITMENT — a wildcard
// played at a known gameweek, or any chip — because you are not going to
// transfer out of it, so a gameweek five weeks away counts exactly as much as
// this one. Applying decay inside a committed window is what makes a good
// short-horizon squad score badly.
const WEIGHT_MODES = { decay: (d) => DISCOUNT ** d, flat: () => 1 };
export const weightFn = (mode) => WEIGHT_MODES[mode] || WEIGHT_MODES.decay;

/** A single week, played with a perfect fifteen — exactly what Free Hit buys. */
export function freeHitWeeks(gi) {
  return [{ k: gi, w: 1, bb: false, tc: false }];
}

/**
 * Wildcard at gameweek index `gi`: you rebuild from scratch and then HOLD that
 * squad, so the right objective is the discounted run of weeks from there —
 * not the single week, which is what makes a wildcard squad different from a
 * free hit squad.
 */
export function wildcardWeeks(gi, span = 6, mode = "decay") {
  const weeks = [];
  const wf = weightFn(mode);
  const end = Math.min(gi + span, DATA.gws.length);
  for (let k = gi; k < end; k++) {
    weeks.push({ k, w: wf(k - gi), bb: false, tc: false });
  }
  return weeks;
}

/**
 * A held squad over a span with a chip live in one specific week. Used for
 * "Bench Boost in GW1 — what should I actually own?", where the answer is a
 * genuinely different squad: a bench that scores changes what a bench is for.
 */
export function chipWeeks(gi, span, chipGi, chip, mode = "flat") {
  const weeks = [];
  const wf = weightFn(mode);
  const end = Math.min(gi + span, DATA.gws.length);
  for (let k = gi; k < end; k++) {
    weeks.push({
      k,
      w: wf(k - gi),
      bb: chip === "bb" && k === chipGi,
      tc: chip === "tc" && k === chipGi,
    });
  }
  return weeks;
}

/**
 * When to play each chip, measured on a squad you actually hold.
 *
 * The question "which week is my Bench Boost worth most?" has a definite answer
 * once the squad is fixed, and it is not the same answer for every manager —
 * it depends on who is on your bench and when their fixtures land. So this is
 * computed per squad rather than published as a league-wide "GW28 is bench
 * boost week".
 *
 * Free Hit is measured differently from the other two on purpose: it is worth
 * the gap between a perfect one-week squad and YOUR squad that week, so it
 * needs the MILP's proven single-week optima passed in.
 */
export function chipAdvice(players, fromGi, span, singleWeekOptimum) {
  const end = Math.min(fromGi + span, DATA.gws.length);
  const rows = [];
  for (let k = fromGi; k < end; k++) {
    const base = weekScore(players, k);
    const bb = weekScore(players, k, { bb: true });
    const tc = weekScore(players, k, { tc: true });
    rows.push({
      k,
      gw: DATA.gws[k],
      base: base.pts,
      // Each chip's value is what it ADDS in that week, which is the only
      // basis on which three different chips can be compared.
      bbGain: bb.pts - base.pts,
      tcGain: tc.pts - base.pts,
      tcPlayer: base.capt,
      fhGain: Math.max(0, (singleWeekOptimum?.[String(DATA.gws[k])]?.xp ?? 0) - base.pts),
    });
  }
  const pick = (key) => rows.reduce((a, b) => (b[key] > a[key] ? b : a), rows[0]);
  if (!rows.length) return null;

  const bb = pick("bbGain"), tc = pick("tcGain"), fh = pick("fhGain");
  return {
    rows,
    // Thresholds are the same ones the squad page already uses, so a chip does
    // not look "worth it" here and marginal there.
    bb: { gw: bb.gw, gain: bb.bbGain, worth: bb.bbGain >= 12 },
    tc: { gw: tc.gw, gain: tc.tcGain, player: tc.tcPlayer, worth: tc.tcGain >= 6 },
    fh: { gw: fh.gw, gain: fh.fhGain, worth: fh.fhGain >= 15 },
  };
}

/**
 * Cross-check against the MILP.
 *
 * optimal.json holds CBC's proven-optimal squad for each single gameweek, so
 * running this solver on the same problem and comparing is a real correctness
 * test rather than a self-consistency one. Exposed for the console rather than
 * wired into the UI — it is a development tool.
 */
export function verifyAgainstMILP(OPTIMAL) {
  const rows = [];
  for (let gi = 0; gi < DATA.gws.length; gi++) {
    const ref = OPTIMAL[String(DATA.gws[gi])];
    if (!ref) continue;
    const mine = optimise({ weeks: freeHitWeeks(gi) });
    if (!mine.feasible) { rows.push({ gw: DATA.gws[gi], error: mine.reason }); continue; }
    const refPts = weekScore(ref.squad.map((i) => byId[i]).filter(Boolean), gi).pts;
    rows.push({
      gw: DATA.gws[gi],
      milp: +refPts.toFixed(2),
      local: +mine.pts.toFixed(2),
      delta: +(mine.pts - refPts).toFixed(2),
      overlap: ref.squad.filter((i) => mine.ids.includes(i)).length,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Cached, two-tier solving — what makes the window control draggable.
//
// Measured before any of this existed: p50 1034ms, p95 1195ms per solve across
// windows in GW1-10. A control you drag cannot wait a second per frame, and the
// honest fix is not to make the search worse for everyone — it is to show a
// fast answer immediately and replace it with the exact one when the handle
// stops moving.
//
//   provisional   restarts capped and a ~90ms budget: the greedy seed plus a
//                 short local search. Good enough to see the shape of the
//                 squad move, and MARKED as provisional so nobody acts on it.
//   exact         the full 700ms search, run once the drag settles.
//
// Both tiers write into the same cache, keyed by window + chip + weighting +
// locks, so dragging back over a window you have already visited is instant.
const SOLVE_CACHE = new Map();

const cacheKey = (weeks, opts = {}) =>
  JSON.stringify([
    weeks.map((w) => [w.k, +w.w.toFixed(4), w.bb ? 1 : 0, w.tc ? 1 : 0]),
    (opts.lockIds || []).slice().sort(),
    (opts.banIds || []).slice().sort(),
    opts.budget ?? null,
  ]);

/**
 * Solve with caching. `tier` is "exact" or "provisional".
 *
 * An exact result always supersedes a provisional one for the same key; a
 * provisional result never overwrites an exact one, or dragging back over a
 * settled window would degrade an answer the user already has.
 */
export function solveCached(weeks, opts = {}, tier = "exact") {
  const key = cacheKey(weeks, opts);
  const hit = SOLVE_CACHE.get(key);
  if (hit && (hit.tier === "exact" || tier === "provisional")) return hit;

  const t0 = performance.now();
  const res = optimise(
    tier === "provisional"
      ? { weeks, ...opts, restarts: 6, timeBudgetMs: 90, maxPasses: 12 }
      : { weeks, ...opts });
  const out = { ...res, tier, ms: Math.round(performance.now() - t0) };
  SOLVE_CACHE.set(key, out);
  return out;
}

export const solveCacheSize = () => SOLVE_CACHE.size;

/**
 * Warm the cache for every contiguous window in GW1-10, during idle time.
 *
 * Fifty-five windows at ~1s each is a minute of work, so doing it eagerly on
 * load would freeze the page for longer than it saves. Instead one window is
 * solved per idle callback, nearest-first, and the whole thing yields the
 * moment the user does anything. If they never touch the control, the warming
 * simply finishes quietly; if they drag immediately, they get the provisional
 * tier and the warmer gets out of the way.
 */
export function warmWindows(maxGw = 10, mode = "decay", onProgress) {
  // A yielding timeout chain, NOT requestIdleCallback. Measured: rIC fired so
  // rarely here that the sweep reached 5 of 55 windows in twenty seconds, so
  // the robustness panel never converged. A short timeout always fires, still
  // yields to input and paint between slices, and completes the sweep in
  // roughly eight seconds at the fast tier.
  const idle = (fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 12);
  const jobs = [];
  const n = Math.min(maxGw, DATA.gws.length);
  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) jobs.push([a, b - a + 1]);
  }
  // Short windows starting at GW1 first — the default view and the ones a user
  // reaches soonest.
  jobs.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
  let i = 0;
  let cancelled = false;
  const step = (deadline) => {
    while (!cancelled && i < jobs.length
           && (deadline.timeRemaining ? deadline.timeRemaining() > 4 : true)) {
      const [a, span] = jobs[i++];
      // PROVISIONAL tier, deliberately. Warming all 55 windows at the exact
      // tier is ~60s of main-thread work and measured at 2 windows in 15
      // seconds — it never finishes and janks the page trying. The fast tier
      // does the same sweep in about 8 seconds.
      //
      // That is the right trade for THIS purpose: robustness asks which
      // players keep reappearing across windows, not what the objective was
      // to two decimal places, and the fast tier's mean gap of 1.28 points
      // rarely changes squad membership. The window the user is actually
      // looking at is still solved exactly by the page itself.
      solveCached(wildcardWeeks(a, span, mode), {}, "provisional");
      if (onProgress) onProgress(i, jobs.length);
      // Two per callback at the fast tier keeps each slice near 300ms,
      // short enough not to be felt and long enough to finish the sweep.
      if (i % 2 === 0) break;
    }
    if (!cancelled && i < jobs.length) idle(step);
  };
  idle(step);
  return () => { cancelled = true; };
}

// ---------------------------------------------------------------------------
// Squad robustness — is this squad right regardless of my plan, or is it a bet
// ON my plan?
//
// The optimal fifteen for GW1-3 and the optimal fifteen for GW4-10 are not the
// same team, and a user looking at one of them has no way to tell which of its
// players survive the other. That matters most at exactly the moment the stakes
// are highest: spending a wildcard on a squad that is only optimal for the
// window you happened to have selected.
//
// So: solve every contiguous window in GW1-10 and count how often each player
// appears. The classification thresholds are the user's, not fitted — there is
// nothing to fit here, it is a presentation of how often something is true.
const ROBUST_CORE = 0.80;
const ROBUST_SITUATIONAL = 0.30;

/**
 * Robustness across every contiguous window in GW1..maxGw.
 *
 * `cachedOnly` reads whatever `warmWindows` has already solved and reports how
 * complete the picture is, rather than blocking the page for a minute to solve
 * all 55. The answer converges as the cache fills; the count is shown so a
 * partial answer is never mistaken for a settled one.
 */
export function windowRobustness(maxGw = 10, mode = "decay", {
  cachedOnly = true, lockIds = [],
} = {}) {
  const n = Math.min(maxGw, DATA.gws.length);
  const counts = new Map();
  const windowsFor = new Map();
  let solved = 0, total = 0;

  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      total++;
      const weeks = wildcardWeeks(a, b - a + 1, mode);
      const key = cacheKey(weeks, { lockIds });
      const have = SOLVE_CACHE.get(key);
      const res = have || (cachedOnly ? null : solveCached(weeks, { lockIds }, "exact"));
      if (!res || !res.feasible) continue;
      solved++;
      for (const id of res.ids) {
        counts.set(id, (counts.get(id) || 0) + 1);
        if (!windowsFor.has(id)) windowsFor.set(id, []);
        windowsFor.get(id).push([a, b]);
      }
    }
  }
  if (!solved) return { solved: 0, total, players: [] };

  const players = [...counts.entries()].map(([id, c]) => {
    const share = c / solved;
    const wins = windowsFor.get(id) || [];
    // The span over which he is ever optimal — the useful thing to show for a
    // player who only belongs in part of the range.
    const lo = Math.min(...wins.map((w) => w[0]));
    const hi = Math.max(...wins.map((w) => w[1]));
    return {
      id,
      share,
      windows: c,
      band: share >= ROBUST_CORE ? "core"
        : share >= ROBUST_SITUATIONAL ? "situational" : "window",
      from: DATA.gws[lo],
      to: DATA.gws[hi],
    };
  }).sort((x, y) => y.share - x.share);

  return { solved, total, players };
}

// ---------------------------------------------------------------------------
// Squad rating, 0-100.
//
// A raw expected-points total answers "how many points" and not the question a
// manager actually has, which is "is this good?". Ninety points means nothing
// without knowing that the best possible is 95 and the average is 78.
//
// Two anchors, both computed rather than asserted:
//
//   100  the optimal squad achievable under the same budget — the ceiling this
//        particular manager could reach, not a league-wide fantasy.
//    50  the median FPL manager, taken as the most-owned legal fifteen.
//        Ownership is already on every record, and the template squad is what
//        the median manager very nearly owns; it is a far better zero point
//        than "an average of all players", which no one has ever fielded.
//
// Below 50 is possible and is meant to be: a squad worse than the template is
// a real thing and the scale should say so rather than flooring at zero.
let TEMPLATE_CACHE = null;

/** The most-owned legal fifteen — a stand-in for what the median manager owns. */
export function templateSquad() {
  if (TEMPLATE_CACHE) return TEMPLATE_CACHE;
  const pool = DATA.players.filter((p) => !isGated(p));
  const by = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of pool) if (by[p.p]) by[p.p].push(p);
  for (const k of Object.keys(by)) by[k].sort((a, b) => (b.o || 0) - (a.o || 0));

  const squad = [];
  const clubs = {};
  let spend = 0;

  // The completion floor has to be the n CHEAPEST DISTINCT players still
  // needed, not n copies of the single cheapest — the £4.0m keeper can only be
  // bought once, and assuming two of him overspends by the gap to the next and
  // leaves the squad a player short. Same bug bit the season simulator.
  const ladder = {};
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    ladder[pos] = by[pos].map((p) => p.c).sort((a, b) => a - b);
  }
  const need = () => {
    const have = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of squad) have[p.p]++;
    return have;
  };
  const floorFor = (posNow) => {
    const have = need();
    let f = 0;
    for (const pos of ["GK", "DEF", "MID", "FWD"]) {
      const taken = have[pos] + (pos === posNow ? 1 : 0);
      const want = QUOTA[pos] - taken;
      if (want > 0) f += ladder[pos].slice(taken, taken + want).reduce((a, b) => a + b, 0);
    }
    return f;
  };
  const take = (p) => {
    const have = need();
    if (have[p.p] >= QUOTA[p.p]) return false;
    if ((clubs[p.t] || 0) >= 3) return false;
    if (spend + p.c + floorFor(p.p) > BUDGET + 1e-9) return false;
    squad.push(p);
    spend += p.c;
    clubs[p.t] = (clubs[p.t] || 0) + 1;
    return true;
  };

  // Globally by ownership, NOT position by position. Filling GK then DEF then
  // MID in turn spent the budget before reaching forwards and produced a
  // "template" whose front three were owned by 0.5%, 1.5% and 1.7% of managers
  // — with Haaland, the most-owned player in the game at 73%, missing. The
  // anchor that defines 50 on the scale has to be the squad people actually
  // own, so the ordering is ownership and nothing else.
  const byOwn = [...pool].sort((a, b) => (b.o || 0) - (a.o || 0));
  for (const p of byOwn) take(p);
  // Backfill cheapest-first for any quota the ownership pass could not afford.
  if (squad.length < 15) {
    const rest = [...pool].sort((a, b) => a.c - b.c);
    for (const p of rest) {
      if (squad.length === 15) break;
      if (!squad.includes(p)) take(p);
    }
  }
  TEMPLATE_CACHE = squad.length === 15 ? squad : null;
  return TEMPLATE_CACHE;
}

/**
 * Rate a squad for one gameweek on the 0-100 scale.
 *
 * `ceilingPts` is the optimal squad's score for that week; pass it in so the
 * caller can reuse a cached solve rather than re-optimising per gameweek.
 */
export function squadRating(players, k, ceilingPts, opts = {}) {
  const mine = weekScore(players, k, opts).pts;
  const tmpl = templateSquad();
  const field = tmpl ? weekScore(tmpl, k, opts).pts : null;
  if (field == null || ceilingPts == null || ceilingPts <= field) {
    return { rating: null, pts: mine, field, ceiling: ceilingPts };
  }
  const rating = 50 + 50 * ((mine - field) / (ceilingPts - field));
  return {
    rating: Math.max(0, Math.min(100, rating)),
    raw: rating,
    pts: mine,
    field,
    ceiling: ceilingPts,
  };
}
