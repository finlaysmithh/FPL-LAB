// What to do this week, and why.
//
// Every number here comes from the same projection engine the rest of the app
// runs on — `p.g[k]` is the model's expected points for that player in that
// gameweek. There is no second model producing a "transfer rating"; a move is
// scored by what it does to the STARTING XI over the next few weeks, which is
// the only thing that pays.
import { DATA, OPTIMAL, byId } from "./logic.js";
import { HIT_COST, MAX_BANK } from "./plan.js";

// How far ahead a move is judged. Four to six weeks is where a fixture swing
// shows up and beyond which the minutes are guesswork — the horizon fit puts
// most of the ranking loss inside the first four gameweeks.
export const LOOKAHEAD = 5;
const DECAY = 0.88;

// A move has to clear this to be worth spending a free transfer on. Below it
// you are converting a bankable asset into noise.
const WORTH_A_TRANSFER = 1.5;

const XI_MIN = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const XI_MAX = { GK: 1, DEF: 5, MID: 5, FWD: 3 };

/** Best legal XI value for a squad in one gameweek, captain doubled. */
function xiValue(ids, k) {
  const by = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const i of ids) {
    const p = byId[i];
    if (p && by[p.p]) by[p.p].push(p);
  }
  for (const pos of Object.keys(by)) by[pos].sort((a, b) => b.g[k] - a.g[k]);
  if (!by.GK.length) return 0;
  let best = 0;
  for (let d = XI_MIN.DEF; d <= XI_MAX.DEF; d++) {
    for (let m = XI_MIN.MID; m <= XI_MAX.MID; m++) {
      const f = 10 - d - m;
      if (f < XI_MIN.FWD || f > XI_MAX.FWD) continue;
      if (by.DEF.length < d || by.MID.length < m || by.FWD.length < f) continue;
      const xi = [by.GK[0], ...by.DEF.slice(0, d), ...by.MID.slice(0, m), ...by.FWD.slice(0, f)];
      const sum = xi.reduce((s, p) => s + p.g[k], 0);
      const capt = Math.max(...xi.map((p) => p.g[k]));
      best = Math.max(best, sum + capt);
    }
  }
  return best;
}

/** Discounted XI value over the lookahead window. */
function windowValue(ids, from, weeks = LOOKAHEAD) {
  let t = 0;
  for (let j = 0; j < weeks && from + j < DATA.gws.length; j++) {
    t += Math.pow(DECAY, j) * xiValue(ids, from + j);
  }
  return t;
}

/**
 * Rank every legal single transfer out of `squad` in gameweek `k`.
 *
 * Scored on the window, not the week: a move that wins Saturday and loses the
 * month is not a good move, and the whole reason to plan ahead is that the two
 * frequently disagree.
 */
export function rankMoves(squad, k, bank = 0, limit = 6) {
  const base = windowValue(squad, k);
  const clubs = {};
  for (const i of squad) {
    const p = byId[i];
    if (p) clubs[p.t] = (clubs[p.t] || 0) + 1;
  }
  const out = [];
  for (const o of squad) {
    const op = byId[o];
    if (!op) continue;
    const budget = bank + op.c;
    for (const np of DATA.players) {
      if (np.p !== op.p || squad.includes(np.i) || np.c > budget + 1e-6) continue;
      const c = (clubs[np.t] || 0) - (np.t === op.t ? 1 : 0);
      if (c >= 3) continue;
      const next = squad.map((i) => (i === o ? np.i : i));
      const gain = windowValue(next, k) - base;
      if (gain <= 0) continue;
      out.push({
        out: op, in: np, gain,
        now: xiValue(next, k) - xiValue(squad, k),
        cash: Math.round((budget - np.c) * 10) / 10,
      });
    }
  }
  out.sort((a, b) => b.gain - a.gain);
  const top = out.slice(0, limit);
  // 100 is the BEST move available to you this week, not an abstract maximum.
  // Every score is therefore reachable, and a 60 means "there is a move 40%
  // better sitting right there" rather than "this is objectively mediocre".
  const ceiling = top.length ? top[0].gain : 1;
  return top.map((m) => ({
    ...m,
    score: Math.max(1, Math.min(100, Math.round((m.gain / ceiling) * 100))),
    label: m.gain >= 6 ? "STRONG MOVE" : m.gain >= 3 ? "GOOD MOVE"
      : m.gain >= WORTH_A_TRANSFER ? "MARGINAL" : "NOT WORTH IT",
  }));
}

/**
 * TRANSFER / ROLL / HOLD / CHIP — with the reason attached.
 *
 * The rolling case is the one most tools get wrong. A free transfer is an
 * asset: banking it buys two moves next week, which is frequently worth more
 * than forcing a marginal one now. So "roll" is a recommendation here, not the
 * absence of one.
 */
export function weekAdvice(row, opts = {}) {
  const k = row.k;
  const moves = rankMoves(row.squad, k, row.inTheBank, 6);
  const best = moves[0] || null;
  const bank = row.bankBefore;
  const already = row.used;

  if (row.chip) {
    return {
      verdict: "CHIP", tone: "chip", moves,
      headline: `${opts.chipName || "Chip"} active in GW${row.gw}`,
      why: opts.chipWhy || "Committed for this week.",
    };
  }
  if (already > 0) {
    return {
      verdict: "PLANNED", tone: "ok", moves,
      headline: `${already} transfer${already === 1 ? "" : "s"} planned`,
      why: row.paid > 0
        ? `${row.paid} of them costs ${row.paid * HIT_COST} points.`
        : "Inside your free transfers, so no hit.",
    };
  }
  if (!best || best.gain < WORTH_A_TRANSFER) {
    return {
      verdict: "ROLL", tone: "roll", moves,
      headline: bank >= MAX_BANK ? "Bank is full — use one" : "Roll the transfer",
      why: bank >= MAX_BANK
        ? `You are at the ${MAX_BANK}-transfer cap, so this week's free one is lost. Take the best move even if it is small.`
        : best
          ? `Nothing here clears ${WORTH_A_TRANSFER.toFixed(1)} points over ${LOOKAHEAD} weeks — the best is ${best.gain.toFixed(1)}. Two transfers next week beats one marginal one now.`
          : "No affordable move improves the starting eleven.",
    };
  }
  const needsHit = bank < 1;
  const net = needsHit ? best.gain - HIT_COST : best.gain;
  if (needsHit && net <= 0) {
    return {
      verdict: "HOLD", tone: "hold", moves,
      headline: "Hold — the hit does not pay",
      why: `${best.in.n} is worth ${best.gain.toFixed(1)} over ${LOOKAHEAD} weeks, which does not cover a ${HIT_COST}-point hit.`,
    };
  }
  return {
    verdict: "TRANSFER", tone: "go", moves,
    headline: `${best.out.n} → ${best.in.n}`,
    why: `+${best.now.toFixed(1)} in GW${row.gw}, +${best.gain.toFixed(1)} across GW${row.gw}–${DATA.gws[Math.min(DATA.gws.length - 1, k + LOOKAHEAD - 1)]}`
      + (needsHit ? `, ${net.toFixed(1)} after the hit.` : ", no hit required."),
  };
}

/**
 * Where each unplayed chip is worth most, measured on the squad the PLAN leaves
 * you with in that week — not on today's team.
 *
 * That distinction is the whole point. A bench boost is only as good as the
 * bench you will actually own by then, and if the plan sells two of your subs
 * in GW4 the answer changes. Computing this off the current squad would give a
 * confident number for a team that will not exist.
 */
// Gameweeks preceded by an international break, from real kickoff gaps.
export const BREAKS = DATA.model?.breaks || [];

/**
 * WHERE is this chip most valuable across the season — not which week gives the
 * biggest immediate boost.
 *
 * AUDIT OF WHAT THIS REPLACES: the previous version scanned every week, took
 * the highest single-week gain, and called that the answer. On a flat calendar
 * that picks essentially at random among near-identical weeks, and it cannot
 * express the thing that actually decides chip timing — that a chip is a
 * one-shot asset whose value is the BEST FUTURE WINDOW, not this Saturday.
 *
 * Strategic value now combines four things the immediate gain cannot see:
 *
 *   immediate    what the chip returns that week (the old model, kept)
 *   reset        an international break before or after the week. Two clear
 *                weeks to reassess injuries, fixtures and structure is exactly
 *                when a Wildcard is worth most, and it is invisible to a
 *                points-per-week scan.
 *   swing        how much the fixture difficulty CHANGES around that week. A
 *                chip played into an improving run compounds; one played at
 *                the top of a good run is spent as the run ends.
 *   opportunity  what you give up by spending it now. A week only marginally
 *                ahead of the next-best is not a reason to commit.
 */
function fixtureSwing(k) {
  // Mean combined difficulty for the four weeks after k against the four
  // before it. Negative means fixtures get easier — the direction you want to
  // be entering, not leaving.
  const teams = Object.keys(DATA.fdr || {});
  if (!teams.length) return 0;
  const mean = (from, to) => {
    let t = 0, n = 0;
    for (const club of teams) {
      const c = DATA.fdr[club]?.c || [];
      for (let j = from; j < to && j < c.length; j++) {
        if (c[j] != null) { t += c[j]; n++; }
      }
    }
    return n ? t / n : 0;
  };
  const before = mean(Math.max(0, k - 4), k);
  const after = mean(k, k + 4);
  return before - after;              // positive = easier ahead
}

export function chipStrategy(weeks, spent = [], weekScore) {
  const out = [];
  for (const [key, label] of [["bb", "Bench Boost"], ["tc", "Triple Captain"]]) {
    if (spent.includes(key)) continue;
    const rows = weeks.map((w) => {
      const players = w.squad.map((i) => byId[i]).filter(Boolean);
      const plain = weekScore(players, w.k, {}).pts;
      const withChip = weekScore(players, w.k, { bb: key === "bb", tc: key === "tc" }).pts;
      const gain = withChip - plain;
      // A break either side makes this a reset window.
      const nearBreak = BREAKS.includes(w.gw) || BREAKS.includes(w.gw + 1);
      const swing = fixtureSwing(w.k);
      // Strategic value, in points-equivalent so it stays comparable to gain.
      const strategic = gain + (nearBreak ? 2.0 : 0) + Math.max(0, swing) * 1.5;
      return { ...w, gain, swing, nearBreak, strategic };
    });
    const byStrategic = [...rows].sort((a, b) => b.strategic - a.strategic);
    const best = byStrategic[0];
    const runnerUp = byStrategic[1];
    if (!best) continue;
    const bar = key === "bb" ? 10 : 5;
    const edge = best.strategic - (runnerUp?.strategic ?? 0);
    out.push({
      key, label, bar,
      gw: best.gw, k: best.k, gain: best.gain,
      swing: best.swing, nearBreak: best.nearBreak,
      strategic: best.strategic, edge,
      worth: best.gain >= bar,
      // PLAY only when the window is both good enough and clearly the best one.
      // Otherwise HOLD — a chip kept is a chip that can still catch a double.
      play: best.gain >= bar && edge >= 1.0,
      value: best.strategic >= bar + 3 ? "HIGH"
        : best.strategic >= bar ? "MEDIUM" : "LOW",
      why: best.nearBreak
        ? `International break either side of GW${best.gw} — a natural reset point for injuries, fixtures and structure.`
        : best.swing > 0.4
          ? `Fixtures ease noticeably from GW${best.gw}, so a chip played here compounds rather than being spent as a good run ends.`
          : `Best available week on the current calendar, but only ${edge.toFixed(1)} ahead of the next — no reason to commit yet.`,
    });
  }
  // ---- Wildcard and Free Hit --------------------------------------------
  //
  // These are squad-REPLACING, so their value is not "what does my team score
  // with a chip on" — it is the gap between what I own and what I could own.
  // Measured directly rather than proxied: for every week, the discounted
  // window value of the best available squad minus the window value of mine.
  //
  // That gap IS the fixture swing. When my players hit a hard run and better
  // options are on easy ones, the gap widens; when my squad is already close
  // to optimal it collapses. No separate swing model is needed, and the
  // previous version's proxy (difficulty deltas times a constant) could not
  // see my players at all — which is why it produced the same answer for
  // everyone and a negative number every week.
  const WC_HORIZON = 8, FH_HORIZON = 1;
  /**
   * How much of the gap a wildcard still owns once free transfers are counted.
   *
   * One free transfer a week means that by week j you have already made j of
   * the changes yourself, so only the first `need` weeks carry any wildcard
   * premium at all. Averaged across the window this returns 1.0 when the
   * rebuild is hopeless by transfers alone and tends to 0 as your squad
   * approaches the target — which is the behaviour that was missing.
   */
  const catchUp = (mineIds, targetIds, horizon) => {
    const need = mineIds.filter((i) => !targetIds.includes(i)).length;
    if (!need) return 0;
    let t = 0;
    for (let j = 0; j < horizon; j++) t += 1 - Math.min(1, j / need);
    return t / horizon;
  };
  for (const [key, label, horizon] of [["wc", "Wildcard", WC_HORIZON],
                                       ["fh", "Free Hit", FH_HORIZON]]) {
    if (spent.includes(key)) continue;
    const rows = weeks.map((w) => {
      // The best squad for that week, from the solved optima the app ships.
      // The rebuild target is the best squad FOR THAT WEEK, then measured over
      // the window that follows it. Using the range-optimal squad instead made
      // the wildcard read +0.0 everywhere for anyone holding that squad — true,
      // but useless, because it cannot see that the same fifteen ages badly
      // once its players hit a hard run. A per-week target is what a manager
      // would actually build on a wildcard in that week.
      const bestIds = (OPTIMAL[String(w.gw)]?.squad
        || OPTIMAL.range?.squad) || [];
      if (!bestIds.length) return { ...w, gain: 0, strategic: 0 };
      const mine = windowValue(w.squad, w.k, horizon);
      const best = windowValue(bestIds, w.k, horizon);
      // FREE TRANSFERS DO MOST OF THIS FOR NOTHING.
      //
      // The raw gap is what a perfect squad scores against yours, and quoting
      // it as the wildcard's value is why this card recommended a wildcard to
      // someone who had just imported the optimal squad: any target that is not
      // literally your own fifteen shows a gap, and the gap was being credited
      // to the chip in full.
      //
      // But a free transfer arrives every week. Over an eight-week window that
      // is eight changes for nothing, so the chip is only worth the part of the
      // gap that free transfers have NOT closed yet. It buys speed, not points.
      // A squad eight players from the target has half its gap discounted; one
      // three players away keeps a quarter, because you are there by GW4 anyway.
      //
      // Free Hit is exempt: it is a one-week chip and no number of free
      // transfers reproduces handing the squad back afterwards.
      const raw = best - mine;
      const gain = key === "wc" ? raw * catchUp(w.squad, bestIds, horizon) : raw;
      const nearBreak = BREAKS.includes(w.gw) || BREAKS.includes(w.gw + 1);
      // The break bonus stays, but as a tie-breaker on a real gain rather than
      // the whole basis for the recommendation.
      return { ...w, gain, nearBreak, strategic: gain + (nearBreak ? 2.0 : 0) };
    });
    const sorted = [...rows].sort((a, b) => b.strategic - a.strategic);
    const best = sorted[0];
    if (!best) continue;
    const edge = best.strategic - (sorted[1]?.strategic ?? 0);
    const bar = key === "wc" ? 12 : 8;
    out.push({
      key, label, bar, gw: best.gw, k: best.k,
      gain: best.gain, swing: 0, nearBreak: best.nearBreak,
      strategic: best.strategic, edge,
      worth: best.gain >= bar,
      play: best.gain >= bar && edge >= 1.5,
      value: best.gain >= bar + 6 ? "HIGH" : best.gain >= bar ? "MEDIUM" : "LOW",
      why: best.gain < bar
        ? `GW${best.gw} is the best window in the range — a rebuild there is worth ${best.gain.toFixed(1)} over ${horizon === 1 ? "the week" : `${horizon} weeks`}. Short of the ${bar} a ${label.toLowerCase()} should return, so hold it: your squad is not weak enough, nor its fixtures bad enough, to spend one of two on.`
        : best.nearBreak
          ? `A rebuild in GW${best.gw} is worth ${best.gain.toFixed(1)} over ${horizon === 1 ? "the week" : `${horizon} weeks`}, and an international break either side gives you the time to do it properly.`
          : `Your squad falls ${best.gain.toFixed(1)} points behind the best available from GW${best.gw} — the widest gap in the range, driven by your players' fixture run.`,
    });
  }

  return out.sort((a, b) => b.strategic - a.strategic);
}
