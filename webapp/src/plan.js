// The season plan: lock a squad, then walk forward a gameweek at a time.
//
// WHY THIS EXISTS
// ---------------
// Every other view answers "what should I do THIS week". A manager does not
// play one week at a time — they bank a transfer now to make two moves before a
// fixture swing, they hold a wildcard for the week the calendar turns, and the
// value of a chip is entirely a question of which week they spend it in.
//
// So this models the actual rules of the game as a sequence:
//
//   * one free transfer arrives each gameweek, bankable up to five
//   * transfers beyond the bank cost four points each
//   * a wildcard or free hit makes that week's transfers unlimited and free
//   * a free hit REVERTS: the squad you take into the next week is the one you
//     had before it, which is the rule people most often plan wrongly
//   * bench boost scores the substitutes, triple captain pays the armband 3x
//
// Everything downstream — the gameweek bar, the squad score, the plan score —
// reads from the resolved plan, so a chip toggled in GW7 changes the number at
// the top of GW7 and nothing else silently disagrees.
import { DATA, byId } from "./logic.js";
import { weekScore } from "./solver.js";

export const FREE_PER_WEEK = 1;
export const MAX_BANK = 5;
export const HIT_COST = 4;
export const CHIPS = [
  ["wc", "Wildcard", "Unlimited transfers, no hit. The squad you build is the one you keep."],
  ["fh", "Free Hit", "Unlimited transfers for one week only — the squad reverts afterwards."],
  ["bb", "Bench Boost", "All fifteen score this week."],
  ["tc", "Triple Captain", "The armband pays three times instead of twice."],
];
export const UNLIMITED = new Set(["wc", "fh"]);

export const emptyPlan = (squad) => ({ base: [...squad], weeks: {} });

/**
 * Walk the plan forward and return one row per gameweek.
 *
 * This is the single source of truth for what a plan is worth. Nothing else
 * recomputes points, or the two numbers would drift apart the moment a rule
 * changed in one place and not the other.
 */
export function resolvePlan(plan, gwCount = DATA.gws.length, startBank = 1) {
  let squad = [...(plan.base || [])];
  let bank = startBank;
  const weeks = [];

  for (let k = 0; k < gwCount; k++) {
    const w = plan.weeks?.[k] || {};
    const chip = w.chip || null;
    const moves = (w.transfers || []).filter((m) => m && m.out != null && m.in != null);
    const unlimited = UNLIMITED.has(chip);

    // A move is only legal if the outgoing player is actually in the squad AND
    // the incoming one is a real player. The second check matters because a
    // plan can outlive the data it was written against — a move naming an id
    // that no longer exists used to leave the squad a player short for the rest
    // of the season rather than being ignored.
    const applied = [];
    let next = [...squad];
    for (const m of moves) {
      const at = next.indexOf(m.out);
      if (at < 0 || next.includes(m.in) || !byId[m.in]) continue;
      next[at] = m.in;
      applied.push(m);
    }

    const used = applied.length;
    const paid = unlimited ? 0 : Math.max(0, used - bank);
    const hits = paid * HIT_COST;

    const players = next.map((i) => byId[i]).filter(Boolean);
    const sc = weekScore(players, k, { bb: chip === "bb", tc: chip === "tc" });

    // Money. Sales are at CURRENT price here, not FPL's purchase-plus-half-the-
    // rise rule — the browser has no purchase history to apply it to. That is a
    // simplification and it is stated on the panel rather than hidden: it makes
    // a plan very slightly optimistic on any player who has risen.
    const cost = next.reduce((t, i) => t + (byId[i]?.c || 0), 0);
    const inTheBank = Math.round((100 - cost) * 10) / 10;

    weeks.push({
      k, gw: DATA.gws[k], chip, transfers: applied,
      cost: Math.round(cost * 10) / 10, inTheBank,
      squad: next, xi: sc.xi, capt: sc.capt,
      raw: sc.pts, hits, points: sc.pts - hits,
      bankBefore: bank, used, paid, locked: !!w.locked,
    });

    // A free hit reverts: next week starts from the squad you had BEFORE it.
    squad = chip === "fh" ? squad : next;
    bank = unlimited
      ? Math.min(MAX_BANK, FREE_PER_WEEK)
      : Math.min(MAX_BANK, bank - Math.min(bank, used) + FREE_PER_WEEK);
  }
  return weeks;
}

/**
 * How good is this plan, 0-100?
 *
 * Anchored on two plans the user could actually have made, not on an abstract
 * maximum: doing NOTHING all season is the floor, and playing every chip in its
 * own best week — with the transfers you actually made — is the ceiling.
 *
 * That is what makes the score fall when a chip is spent in a mediocre week.
 * It is not punishing you for playing Triple Captain; it is measuring the gap
 * between the week you chose and the week that was available.
 */
export function planQuality(plan, gwCount = DATA.gws.length, startBank = 1) {
  const weeks = resolvePlan(plan, gwCount, startBank);
  const total = weeks.reduce((s, w) => s + w.points, 0);

  // Floor: the same starting squad, untouched, no chips.
  const flat = resolvePlan({ base: plan.base, weeks: {} }, gwCount, startBank);
  const floor = flat.reduce((s, w) => s + w.points, 0);

  // Ceiling: the transfers you planned, but each chip moved to its best week.
  const chipsUsed = weeks.filter((w) => w.chip).map((w) => w.chip);
  let ceiling = weeks.reduce((s, w) => s + w.raw - w.hits, 0);
  const gains = {};
  for (const c of chipsUsed) {
    let best = 0;
    for (let k = 0; k < gwCount; k++) {
      const base = flat[k];
      if (!base) continue;
      const players = base.squad.map((i) => byId[i]).filter(Boolean);
      const withChip = weekScore(players, k, { bb: c === "bb", tc: c === "tc" }).pts;
      best = Math.max(best, withChip - base.raw);
    }
    gains[c] = best;
  }
  // What the chips actually returned, against what their best week offered.
  let got = 0, could = 0;
  for (const w of weeks) {
    if (!w.chip || UNLIMITED.has(w.chip)) continue;
    const players = flat[w.k]?.squad.map((i) => byId[i]).filter(Boolean) || [];
    const plain = weekScore(players, w.k, {}).pts;
    const withChip = weekScore(players, w.k, { bb: w.chip === "bb", tc: w.chip === "tc" }).pts;
    got += withChip - plain;
    could += gains[w.chip] || 0;
  }

  const span = Math.max(1e-6, (could - got) + Math.max(4, Math.abs(total - floor)));
  const score = 50 + 50 * ((total - floor) - (could - got)) / span;
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    total: Math.round(total * 10) / 10,
    floor: Math.round(floor * 10) / 10,
    gained: Math.round((total - floor) * 10) / 10,
    chipsGot: Math.round(got * 10) / 10,
    chipsCould: Math.round(could * 10) / 10,
    chipsLeft: Math.round((could - got) * 10) / 10,
    weeks,
  };
}

/** Chips already committed, so one cannot be spent twice. */
export const chipsSpent = (plan) =>
  Object.values(plan.weeks || {}).map((w) => w.chip).filter(Boolean);
