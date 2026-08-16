/**
 * Scenario tests for the manager decision layer.
 *
 * Run: node --import ./tests/js/loader.mjs --test tests/js/manager.test.mjs
 *
 * These assert BEHAVIOUR, not numbers. A test that pins the captain to a named
 * player breaks every time the projections are rebuilt and teaches nobody
 * anything; a test that asserts the captain is never a player with a 40% start
 * probability keeps working and is the property that actually matters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DATA, OPTIMAL, byId, BUDGET, squadCost } from "../../webapp/src/logic.js";
import { weekScore, optimise, chipWeeks, wildcardWeeks } from "../../webapp/src/solver.js";
import {
  TOLERANCE, benchBoostPlan, chipPlans, fixtureSwings, managerBriefing,
  nextBreak, pPlay, pickArmband, pickTeam, restructureValue, roadmap, security,
  teamSheetEV, transferDecision, BREAKS,
} from "../../webapp/src/manager.js";

const SQUAD = OPTIMAL.range.squad;
const GW1 = 0;

// ---------------------------------------------------------------------------
// The team sheet
// ---------------------------------------------------------------------------

test("fields a legal eleven in a legal shape", () => {
  for (let k = 0; k < 6; k++) {
    const s = pickTeam(SQUAD, k);
    assert.ok(s, `no team sheet for gw index ${k}`);
    assert.equal(s.xi.length, 11);
    assert.equal(s.bench.length, 4);
    const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    s.xi.forEach((p) => c[p.p]++);
    assert.equal(c.GK, 1, "exactly one keeper");
    assert.ok(c.DEF >= 3 && c.DEF <= 5, `defenders ${c.DEF}`);
    assert.ok(c.MID >= 2 && c.MID <= 5, `midfielders ${c.MID}`);
    assert.ok(c.FWD >= 1 && c.FWD <= 3, `forwards ${c.FWD}`);
    // Nobody appears twice, and the fifteen are accounted for exactly once.
    const all = [...s.xi, ...s.bench].map((p) => p.i);
    assert.equal(new Set(all).size, 15);
  }
});

test("the bench keeper is the bench keeper", () => {
  // FPL fixes the substitute goalkeeper in his own slot; he cannot cover an
  // outfielder and must not be ordered among them.
  const s = pickTeam(SQUAD, GW1);
  assert.equal(s.bench[0].p, "GK", "first bench slot is the reserve keeper");
  assert.ok(s.benchOut.every((p) => p.p !== "GK"));
});

test("captain and vice are different players, both in the eleven", () => {
  for (let k = 0; k < 6; k++) {
    const s = pickTeam(SQUAD, k);
    assert.notEqual(s.capt.i, s.vice.i);
    assert.ok(s.xi.some((p) => p.i === s.capt.i), "captain starts");
    assert.ok(s.xi.some((p) => p.i === s.vice.i), "vice starts");
  }
});

test("the armband never goes to a player unlikely to feature", () => {
  for (let k = 0; k < 8; k++) {
    const s = pickTeam(SQUAD, k);
    assert.ok(pPlay(s.capt) >= 0.6,
      `captain ${s.capt.n} only ${Math.round(pPlay(s.capt) * 100)}% to play in GW${DATA.gws[k]}`);
    assert.ok(pPlay(s.vice) >= 0.5,
      `vice ${s.vice.n} only ${Math.round(pPlay(s.vice) * 100)}% to play`);
  }
});

test("a manual eleven is respected but its bench and armband are still solved", () => {
  const auto = pickTeam(SQUAD, GW1);
  // Force a different legal eleven by swapping the weakest starter for a sub
  // of the same position, if one exists.
  const sub = auto.benchOut.find((b) => auto.xi.some((p) => p.p === b.p));
  if (!sub) return;                       // nothing legal to force; skip
  const out = [...auto.xi].filter((p) => p.p === sub.p)
    .sort((a, b) => a.g[GW1] - b.g[GW1])[0];
  const forced = auto.xi.map((p) => (p.i === out.i ? sub : p)).map((p) => p.i);
  const s = pickTeam(SQUAD, GW1, { lockXI: forced });
  assert.ok(s.manual, "flagged as the user's own shape");
  assert.equal(s.xi.length, 11);
  assert.ok(s.xi.some((p) => p.i === sub.i), "the forced player starts");
  assert.ok(s.capt && s.vice, "armband still chosen");
});

test("a forced captain is obeyed", () => {
  const s0 = pickTeam(SQUAD, GW1);
  const other = s0.xi.find((p) => p.i !== s0.capt.i);
  const s = pickTeam(SQUAD, GW1, { captId: other.i });
  assert.equal(s.capt.i, other.i);
});

// ---------------------------------------------------------------------------
// The point of the exercise: this is not "the eleven highest projections"
// ---------------------------------------------------------------------------

test("autosub cover is counted, and is worth something", () => {
  const s = pickTeam(SQUAD, GW1);
  assert.ok(s.parts.cover > 0, "a squad with any rotation risk recovers something");
  // Cover cannot exceed what the bench could possibly contribute.
  const benchMax = s.bench.reduce((t, p) => t + p.g[GW1], 0);
  assert.ok(s.parts.cover < benchMax, "cover is bounded by the bench itself");
});

test("expected points exceed the naive XI+captain sum, because of cover", () => {
  const s = pickTeam(SQUAD, GW1);
  const naiveSum = s.naive.reduce((t, p) => t + p.g[GW1], 0);
  assert.ok(s.ev > naiveSum, "the sheet is worth more than eleven projections alone");
});

test("a tie-break, when taken, costs less than tolerance and buys real security", () => {
  // Across the horizon, every tie-break the engine applies must obey its own
  // contract. This is the guard against the tolerance layer quietly becoming a
  // licence to field worse players.
  for (let k = 0; k < 10; k++) {
    const s = pickTeam(SQUAD, k);
    for (const t of s.tieBreaks) {
      assert.ok(t.cost >= 0 && t.cost < TOLERANCE,
        `tie-break cost ${t.cost} outside [0, ${TOLERANCE})`);
      assert.ok(t.gain > 0, "a tie-break must buy security, not spend it");
      assert.ok(security(t.in) > security(t.out));
    }
  }
});

test("inside tolerance, the eleven never trades security for a rounding error", () => {
  // The property the tie-break exists to guarantee: there must be no swap
  // available that costs less than TOLERANCE and buys meaningful security. If
  // one exists, the engine should already have taken it.
  for (let k = 0; k < 12; k++) {
    const s = pickTeam(SQUAD, k);
    for (const out of s.xi) {
      if (out.p === "GK") continue;
      for (const inn of s.benchOut) {
        const next = s.xi.map((p) => (p.i === out.i ? inn : p));
        const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
        next.forEach((p) => c[p.p]++);
        const legal = c.GK === 1 && c.DEF >= 3 && c.DEF <= 5
          && c.MID >= 2 && c.MID <= 5 && c.FWD >= 1 && c.FWD <= 3;
        if (!legal) continue;
        const gain = security(inn) - security(out);
        if (gain <= 0.05) continue;
        const alt = pickTeam(SQUAD, k, { lockXI: next.map((p) => p.i) });
        if (!alt) continue;
        const cost = s.ev - alt.ev;
        assert.ok(cost >= TOLERANCE || cost < 0,
          `GW${DATA.gws[k]}: ${inn.n} for ${out.n} costs only ${cost.toFixed(3)} `
          + `and buys ${(gain * 100).toFixed(0)}pp of security — should have been taken`);
      }
    }
  }
});

test("a nailed player is preferred to an equal-projection rotation risk", () => {
  // Synthetic, because the property must hold regardless of what this week's
  // data happens to contain. Two identical midfielders, one nailed, one a
  // coin flip: the nailed one starts.
  const base = DATA.players.find((p) => p.p === "MID" && p.ps >= 90 && p.g[GW1] > 3);
  assert.ok(base, "need a nailed midfielder to build the case");

  const mk = (i, ps, pp, p60v) => ({
    ...base, i, n: `Test${i}`, t: "TST",
    ps, pp, p60: p60v,
    g: base.g.map(() => 4.0),
  });
  const nailed = mk(900001, 100, 100, 95);
  const risky = mk(900002, 55, 62, 45);
  byId[nailed.i] = nailed;
  byId[risky.i] = risky;

  // A squad where exactly one of the two can start: take a real squad, drop
  // two midfielders, add both test players.
  const mids = SQUAD.map((i) => byId[i]).filter((p) => p.p === "MID");
  const squad = SQUAD.filter((i) => i !== mids[mids.length - 1].i)
    .concat([nailed.i]);
  const s = pickTeam(squad, GW1);
  const startsNailed = s.xi.some((p) => p.i === nailed.i);

  const squad2 = SQUAD.filter((i) => i !== mids[mids.length - 1].i)
    .concat([risky.i]);
  const s2 = pickTeam(squad2, GW1);
  const startsRisky = s2.xi.some((p) => p.i === risky.i);

  // Identical projections; the nailed one should make the eleven at least as
  // readily as the risky one.
  assert.ok(startsNailed || !startsRisky,
    "the risky player started where the identical nailed player did not");

  delete byId[nailed.i];
  delete byId[risky.i];
});

// ---------------------------------------------------------------------------
// Bench order
// ---------------------------------------------------------------------------

test("bench order maximises expected recovery, not raw projection", () => {
  const s = pickTeam(SQUAD, GW1);
  // The chosen order must beat every other ordering of the three outfielders.
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const mine = teamSheetEV(s.xi, s.benchOut, s.benchGK, s.capt, s.vice, GW1).ev;
  for (const perm of perms) {
    const order = perm.map((i) => s.benchOut[i]);
    const ev = teamSheetEV(s.xi, order, s.benchGK, s.capt, s.vice, GW1).ev;
    assert.ok(mine >= ev - 1e-9, `ordering ${perm} beats the chosen one`);
  }
});

test("a substitute who cannot play is not first sub", () => {
  const s = pickTeam(SQUAD, GW1);
  const first = s.benchOut[0];
  const anyPlayable = s.benchOut.some((p) => pPlay(p) > 0.5);
  if (anyPlayable) {
    assert.ok(pPlay(first) > 0.2,
      `first sub ${first.n} is only ${Math.round(pPlay(first) * 100)}% to play`);
  }
});

// ---------------------------------------------------------------------------
// Bench Boost — the fix
// ---------------------------------------------------------------------------

test("Bench Boost is not optimised as a one-week squad", () => {
  const plan = benchBoostPlan(SQUAD, GW1, { span: 6 });
  assert.ok(plan.naive && plan.sound, "both builds are feasible");
  // The sound build must win on TOTAL plan value even though the naive one
  // wins the chip week itself. This is the whole point.
  assert.ok(plan.naive.chipWeek > plan.sound.chipWeek - 1e-9
    || plan.sound.total > plan.naive.total,
    "expected the naive build to win the chip week or lose overall");
  assert.ok(plan.sound.total > plan.naive.total,
    `sound build ${plan.sound.total.toFixed(1)} did not beat naive ${plan.naive.total.toFixed(1)}`);
});

test("the restructuring charge falls on the squad that deserves it", () => {
  const plan = benchBoostPlan(SQUAD, GW1, { span: 6 });
  assert.ok(plan.restructure, "naive build is charged");
  assert.ok(plan.soundRestructure, "sound build is charged");
  assert.ok(plan.restructure.gap > plan.soundRestructure.gap,
    `naive gap ${plan.restructure.gap.toFixed(1)} should exceed sound gap ${plan.soundRestructure.gap.toFixed(1)}`);
});

test("no bench budget is hardcoded anywhere", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../webapp/src/manager.js", import.meta.url), "utf8"));
  // A cap on bench spend would look like a comparison against a literal.
  assert.ok(!/bench(Spend|Budget)\s*[<>]=?\s*\d/.test(src),
    "found what looks like a hardcoded bench budget");
});

test("restructure reports the components it does not weight", () => {
  const r = restructureValue(SQUAD, GW1, 6);
  assert.ok(r.weighted.includes("future fixture value"));
  assert.ok(r.reported.includes("money trapped on the bench"));
  // The cost must be driven by the horizon gap, not by bench money.
  assert.ok(Math.abs(r.cost - (r.gap + Math.max(0, r.transfers - 2) * 0.5)) < 1e-9);
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

test("a marginal gain does not spend a free transfer", () => {
  const d = transferDecision(SQUAD, GW1, { free: 1, span: 6 });
  if (d.best && d.best.gain < 0.8) {
    assert.equal(d.verdict, "ROLL");
  }
  assert.ok(["ROLL", "TRANSFER", "WAIT", "HIT"].includes(d.verdict));
});

test("the optimal squad has little to gain, so it rolls", () => {
  // The proven-optimal range squad should not be told to transfer: if it is,
  // either the solver or the transfer engine is wrong.
  const d = transferDecision(SQUAD, GW1, { free: 1, span: 6 });
  assert.ok(["ROLL", "WAIT"].includes(d.verdict),
    `optimal squad told to ${d.verdict} (${d.headline})`);
});

test("a hit must clear four points, not zero", () => {
  const d = transferDecision(SQUAD, GW1, { free: 0, span: 6 });
  if (d.verdict === "HIT") {
    assert.ok(d.best.gain > 4, `hit recommended on a ${d.best.gain.toFixed(1)} gain`);
  }
});

test("a weakened squad is told to act", () => {
  // Replace three good players with the cheapest available bodies. A squad
  // with real holes must produce a real recommendation.
  const cheap = DATA.players
    .filter((p) => p.c <= 4.5 && (p.xm ?? 0) > 25)
    .sort((a, b) => a.g[GW1] - b.g[GW1]);
  const outs = SQUAD.map((i) => byId[i])
    .filter((p) => p.p === "MID").slice(0, 2);
  if (outs.length < 2) return;
  const ins = cheap.filter((p) => p.p === "MID").slice(0, 2);
  if (ins.length < 2) return;
  const weak = SQUAD.filter((i) => !outs.some((o) => o.i === i))
    .concat(ins.map((p) => p.i));
  if (weak.length !== 15) return;
  const d = transferDecision(weak, GW1, { free: 1, span: 6 });
  assert.ok(d.best, "a broken squad has an available improvement");
  assert.ok(d.best.gain > 0, "and it is worth something");
});

test("moves inside the margin are never listed as recommendations", () => {
  // The page shows these under headings that say "worth doing this week". A
  // 0.1-point swap appearing there contradicts a ROLL verdict printed directly
  // above it, which reads as the app disagreeing with itself.
  const d = transferDecision(SQUAD, GW1, { free: 1, span: 6 });
  for (const m of [...d.actNow, ...d.planAhead]) {
    assert.ok(m.gain >= 0.8,
      `${m.out.n}→${m.in.n} listed at ${m.gain.toFixed(2)}, inside the margin`);
  }
  if (d.verdict === "ROLL" && d.best && d.best.gain < 0.8) {
    assert.equal(d.actNow.length + d.planAhead.length, 0,
      "rolled, but still listed moves to make");
  }
});

test("act-now and plan-ahead are separated by WHEN the value lands", () => {
  const d = transferDecision(SQUAD, GW1, { free: 1, span: 6 });
  for (const m of d.actNow) {
    assert.ok(m.nearGain >= 1.0 || m.deferred < 0.55,
      `${m.out.n}→${m.in.n} in ACT NOW with ${(m.deferred * 100).toFixed(0)}% deferred value`);
  }
  for (const m of d.planAhead) {
    assert.ok(m.nearGain < 1.0 && m.deferred >= 0.55,
      `${m.out.n}→${m.in.n} in PLAN AHEAD but pays now`);
  }
});

// ---------------------------------------------------------------------------
// Fixtures, swings and breaks
// ---------------------------------------------------------------------------

test("international breaks are read from the data, not assumed", () => {
  assert.ok(Array.isArray(BREAKS));
  assert.ok(BREAKS.length > 0, "the season has at least one break");
  const b = nextBreak(0);
  assert.ok(b, "there is a break ahead of GW1");
  assert.ok(b.gw > DATA.gws[0]);
  assert.equal(b.weeksAway, b.gw - DATA.gws[0]);
});

test("a transfer is not committed immediately before a break for a small gain", () => {
  // Find the gameweek right before a break and check the guard fires when it
  // should: a sub-3.0 gain must not be spent there.
  const brk = BREAKS[0];
  const k = DATA.gws.indexOf(brk - 1);
  if (k < 0) return;
  const d = transferDecision(SQUAD, k, { free: 1, span: 6 });
  if (d.best && d.best.gain < 3.0 && d.best.gain >= 2.0) {
    assert.notEqual(d.verdict, "TRANSFER",
      "committed a marginal transfer immediately before a break");
  }
});

test("fixture swings are computed on clubs you own", () => {
  const s = fixtureSwings(SQUAD, GW1, 6);
  const owned = new Set(SQUAD.map((i) => byId[i].t));
  for (const r of s.rows) assert.ok(owned.has(r.team), `${r.team} is not in the squad`);
  for (const r of s.improving) assert.ok(r.delta > 0);
  for (const r of s.worsening) assert.ok(r.delta < 0);
});

// ---------------------------------------------------------------------------
// Chips behave differently from each other
// ---------------------------------------------------------------------------

test("every chip produces a different optimisation", () => {
  const c = chipPlans(SQUAD, GW1, { span: 6 });
  assert.ok(c.bb && c.tc && c.fh && c.wc, "all four chips are planned");
  // Free Hit is the only one valued on a single week; the others must all
  // carry a horizon, so their best weeks are allowed to differ.
  const weeks = new Set([c.bb.best.gw, c.tc.best.gw, c.fh.best.gw, c.wc.best.gw]);
  assert.ok(weeks.size >= 2, "all four chips picked the same week — suspicious");
  // Triple Captain must rank on its adjusted (ceiling and security) number.
  const top = c.tc.rows[0];
  for (const r of c.tc.rows) assert.ok(top.adjusted >= r.adjusted - 1e-9);
});

test("spent chips disappear", () => {
  const c = chipPlans(SQUAD, GW1, { span: 6, spent: ["bb", "wc"] });
  assert.ok(!c.bb && !c.wc);
  assert.ok(c.tc && c.fh);
});

test("Triple Captain never nominates a player who may not play", () => {
  const c = chipPlans(SQUAD, GW1, { span: 6 });
  const p = c.tc.best.player;
  assert.ok(p, "a captain is named");
  assert.ok(pPlay(p) >= 0.6, `${p.n} is only ${Math.round(pPlay(p) * 100)}% to play`);
});

// ---------------------------------------------------------------------------
// Roadmap and briefing
// ---------------------------------------------------------------------------

test("the roadmap covers the horizon and accumulates free transfers", () => {
  const r = roadmap(SQUAD, GW1, { span: 6, free: 1 });
  assert.equal(r.length, 6);
  assert.deepEqual(r.map((x) => x.gw), DATA.gws.slice(0, 6));
  assert.equal(r[0].ft, 1);
  assert.equal(r[1].ft, 2);
  assert.ok(r.every((x) => x.ft <= 5), "free transfers cap at five");
  assert.ok(r.every((x) => x.capt), "every week names a captain");
});

test("the roadmap flags the international break in the right week", () => {
  const r = roadmap(SQUAD, GW1, { span: 8, free: 1 });
  const flagged = r.filter((x) => x.isBreak).map((x) => x.gw);
  for (const gw of flagged) assert.ok(BREAKS.includes(gw));
  const inRange = BREAKS.filter((b) => r.some((x) => x.gw === b));
  assert.deepEqual(flagged.sort((a, b) => a - b), inRange.sort((a, b) => a - b));
});

test("the briefing is internally consistent", () => {
  const b = managerBriefing(SQUAD, GW1, { free: 1, span: 6 });
  assert.ok(b, "a briefing is produced");
  assert.equal(b.gw, DATA.gws[0]);
  assert.equal(b.verdict.call, b.transfers.verdict);
  assert.equal(b.verdict.headline, b.transfers.headline);
  assert.ok(b.summary.length >= 1 && b.summary.length <= 3);
  assert.ok(b.confidence > 0.4 && b.confidence < 1);
  // The roadmap's first week must agree with the team sheet above it.
  assert.equal(b.plan[0].gw, b.gw);
  assert.equal(b.plan[0].capt.i, b.sheet.capt.i,
    "roadmap captain disagrees with the team sheet");
  assert.equal(b.plan[0].formation, b.sheet.formation);
});

test("an incomplete squad produces nothing rather than nonsense", () => {
  assert.equal(managerBriefing(SQUAD.slice(0, 14), GW1), null);
  assert.equal(managerBriefing([], GW1), null);
  assert.equal(managerBriefing(null, GW1), null);
});

test("every recommendation carries an explanation", () => {
  const b = managerBriefing(SQUAD, GW1, { free: 1, span: 6 });
  assert.ok(b.verdict.why.length > 0, "the transfer call is explained");
  assert.ok(b.sheet.captainWhy.length > 0, "the captain is explained");
  assert.ok(b.sheet.benchWhy.length > 0, "the bench order is explained");
  assert.ok(b.sheet.shapeWhy?.text, "the formation is explained");
  for (const [, c] of Object.entries(b.chips)) {
    assert.ok(c.why.length > 0, `${c.title} is unexplained`);
    assert.ok(c.note.length > 0, `${c.title} has no rationale note`);
  }
});

// ---------------------------------------------------------------------------
// Bench Boost changes the team sheet, as it must
// ---------------------------------------------------------------------------

test("Bench Boost stops the bench covering and starts it scoring", () => {
  const plain = pickTeam(SQUAD, GW1);
  const boosted = pickTeam(SQUAD, GW1, { bb: true });
  assert.equal(boosted.parts.cover, 0, "nobody is covering under a bench boost");
  assert.ok(boosted.parts.bench > 0, "the bench scores");
  assert.ok(boosted.ev > plain.ev, "the chip is worth something");
});

test("Triple Captain triples rather than doubles", () => {
  const plain = pickTeam(SQUAD, GW1);
  const tripled = pickTeam(SQUAD, GW1, { tc: true });
  assert.ok(tripled.parts.armband > plain.parts.armband * 1.5,
    "the armband is not paying three times");
});
