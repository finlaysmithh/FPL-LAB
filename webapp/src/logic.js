// Squad rules, scoring and the transfer engine. Data and maths only, plus one
// viewport hook that the layout depends on.
import React from "react";
import DATA from "../data.json";
import OPTIMAL from "../optimal.json";

export { DATA, OPTIMAL };

export const QUOTA = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const XI_MIN = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
export const XI_MAX = { GK: 1, DEF: 5, MID: 5, FWD: 3 };
export const BUDGET = 100.0;
export const POS_ORDER = ["GK", "DEF", "MID", "FWD"];
export const POS_LABEL = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward" };

export const byId = {};
DATA.players.forEach((p) => (byId[p.i] = p));

export const money = (v) => "£" + v.toFixed(1) + "m";

// One gameweek's fixture for a club. The exporter encodes venue in the case of
// the opponent code — CAPS for home, lower-case for away — so the venue never
// needs a second field.
export function fixtureAt(team, gi) {
  const f = DATA.fdr[team];
  if (!f) return null;
  const raw = f.o?.[gi];
  if (!raw || raw === "-") return null;
  return {
    opp: String(raw).toUpperCase(),
    home: String(raw) === String(raw).toUpperCase(),
    // COMBINED difficulty, not attacking difficulty. A player's fixture chip
    // is answering "how hard is this game", and attack-only made a trip to an
    // elite side look kind whenever the club itself creates chances. The
    // attacking and defensive splits are still available in the Fixtures tab,
    // where the question being asked is explicitly one or the other.
    fdr: f.c?.[gi] ?? f.a?.[gi],
    fdrAttack: f.a?.[gi],
    fdrDefence: f.d?.[gi],
  };
}

// Five bands: easy · fair · awkward · tricky · brutal.
//
// Eight was too many. Difficulty is a soft, noisy quantity and a reader cannot
// hold eight tiers in their head, let alone tell "kind" from "easy" or
// "tricky" from "hard" at a glance — the extra tiers implied a precision the
// underlying rating does not have. Five is the number of distinctions the
// scale can actually support.
//
// Cut at the QUINTILES of the season's real combined-difficulty distribution,
// so each band carries a fifth of the calendar and a colour change always
// means a genuine change in rank. The ramp still ends in a dark red, because
// the top fifth has to hold away trips to Arsenal, Man City and Liverpool, and
// those should not share a colour with an ordinary hard away day.
// ---- horizon confidence ---------------------------------------------------
// How far ahead a gameweek is, and therefore how much the projection for it is
// worth. The bands and the decay are both measured — see config.py and
// data/horizon_decay.csv — not chosen to look reassuring.
//
// Deliberately NOT a red/amber/green scale. A distant gameweek is not a BAD
// gameweek, it is a less certain one, and colouring it like a warning would
// tell a user to avoid a fixture that may well be excellent. Confidence is
// carried by how solid the mark is instead, so nothing picks up a false
// valence from hue.
export const HORIZON_BANDS = DATA.model?.horizon_bands || [
  [1, 3, "forecast"], [4, 8, "scenario"], [9, 99, "planning aid"],
];
export const HORIZON_DECAY = DATA.model?.horizon_decay ?? null;
const HORIZON_CURVE = DATA.model?.horizon_curve || [];

// Index in DATA.gws -> band 0/1/2. `gi` is an offset from the first projected
// gameweek, which is what "how far ahead" means from where the user stands.
export function horizonBand(gi) {
  const ahead = gi + 1;
  for (let b = 0; b < HORIZON_BANDS.length; b++) {
    const [lo, hi] = HORIZON_BANDS[b];
    if (ahead >= lo && ahead <= hi) return b;
  }
  return HORIZON_BANDS.length - 1;
}
export const horizonLabel = (gi) => HORIZON_BANDS[horizonBand(gi)]?.[2] || "";

// Measured typical error for a projection this far ahead, in points. Null when
// the sweep has not been run — an absent measurement is shown as absent.
export function horizonError(gi) {
  const row = HORIZON_CURVE.find((r) => r.ahead === gi + 1);
  if (row) return row.mae;
  return HORIZON_CURVE.length ? HORIZON_CURVE[HORIZON_CURVE.length - 1].mae : null;
}

// Decimals a projection at this horizon can actually support. Beyond the first
// band the second decimal is not information, it is decoration.
export const horizonPrecision = (gi) => (horizonBand(gi) >= 2 ? 0 : 1);

export const FDR_BANDS = [
  [3.6, "#00E67A", "easy"],
  [4.9, "#8BE24A", "fair"],
  [6.0, "#F5C542", "awkward"],
  [7.3, "#F5772E", "tricky"],
  [Infinity, "#8E1119", "brutal"],
];

export function fdrColor(v) {
  if (v == null) return "#4A3355";
  return FDR_BANDS.find(([hi]) => v <= hi)[1];
}
export function fdrLabel(v) {
  if (v == null) return "blank";
  return FDR_BANDS.find(([hi]) => v <= hi)[2];
}
// White ink only on the dark red at the top. The four below it — neon green
// through mid orange — are all light enough that white text on them fails
// contrast.
export const fdrInk = (v) => (v == null || v > 7.3 ? "#fff" : "#160020");

// ---- squad maths ----------------------------------------------------------
export const posCounts = (ids) => {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  ids.forEach((i) => byId[i] && c[byId[i].p]++);
  return c;
};
export const clubCounts = (ids) => {
  const c = {};
  ids.forEach((i) => byId[i] && (c[byId[i].t] = (c[byId[i].t] || 0) + 1));
  return c;
};
export const squadCost = (ids) => ids.reduce((s, i) => s + (byId[i]?.c || 0), 0);

export function validate(ids) {
  const errs = [];
  const pc = posCounts(ids);
  POS_ORDER.forEach((p) => pc[p] !== QUOTA[p] && errs.push(`${pc[p]}/${QUOTA[p]} ${p}`));
  Object.entries(clubCounts(ids)).forEach(([t, n]) => n > 3 && errs.push(`${n} from ${t} (max 3)`));
  if (squadCost(ids) > BUDGET + 1e-6) errs.push(`${money(squadCost(ids))} over budget`);
  return errs;
}

// Legal FPL shapes. 4-5-1 and 4-4-2 dominate real usage, but the shape that
// actually maximises points is whichever one your fifteen support — which is
// the whole reason manual substitution has to be allowed.
export const FORMATIONS = [
  [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1],
];
export const formationName = (xi) => {
  const c = { DEF: 0, MID: 0, FWD: 0 };
  xi.forEach((p) => { if (c[p.p] != null) c[p.p]++; });
  return `${c.DEF}-${c.MID}-${c.FWD}`;
};

// Is this set of eleven a legal FPL side?
export function isLegalXI(xi) {
  if (xi.length !== 11) return false;
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  xi.forEach((p) => c[p.p]++);
  if (c.GK !== 1) return false;
  return FORMATIONS.some(([d, m, f]) => c.DEF === d && c.MID === m && c.FWD === f);
}

// Swapping one player for another, would the eleven still be legal? Used to
// grey out impossible substitutions before the user tries them.
export function canSwap(xi, benchPlayer, outPlayer) {
  const next = xi.filter((p) => p.i !== outPlayer.i).concat([benchPlayer]);
  return isLegalXI(next);
}

// Best possible eleven under one fixed shape, so shapes can be compared
// on YOUR fifteen rather than on league averages.
export function bestXIForShape(ids, gi, [d, m, f]) {
  const pool = ids.map((i) => byId[i]).filter(Boolean);
  const pick = (pos, n) => pool.filter((p) => p.p === pos)
    .sort((a, b) => b.g[gi] - a.g[gi]).slice(0, n);
  const gk = pick("GK", 1), def = pick("DEF", d), mid = pick("MID", m), fwd = pick("FWD", f);
  if (gk.length < 1 || def.length < d || mid.length < m || fwd.length < f) return null;
  const xi = [...gk, ...def, ...mid, ...fwd];
  const capt = [...xi].sort((a, b) => captainValue(b, gi) - captainValue(a, gi))[0];
  return { xi, pts: xi.reduce((s, p) => s + p.g[gi], 0) + (capt ? capt.g[gi] : 0) };
}

// Every legal shape your squad can field this week, ranked. Forwards average
// more points per start than midfielders, who average more than defenders
// (2025/26: 4.13 / 3.97 / 3.70), which is why 4-5-1 — the shape most managers
// default to — is rarely the best one available.
export function shapeOptions(ids, gi) {
  return FORMATIONS.map((shape) => {
    const r = bestXIForShape(ids, gi, shape);
    return r && { name: shape.join("-"), shape, pts: r.pts, ids: r.xi.map((p) => p.i) };
  }).filter(Boolean).sort((a, b) => b.pts - a.pts);
}

// captId (optional): a manually chosen captain. Used when they're in the XI;
// otherwise the highest-projected starter wears the armband automatically.
// startIds (optional): a manually chosen eleven. When present and legal it
// overrides the automatic pick entirely — your team, your call.
/**
 * Captain value — expected points, weighted by upside.
 *
 * The armband doubles a score, so on pure expectation the right captain is
 * simply the highest projected player. But FPL is a RANK-ORDER game: you are
 * not trying to score points, you are trying to score more than everyone else,
 * and a haul separates you from the field in a way that a safe six does not.
 *
 * Gameweek 1 is the case in point. Gabriel projects 6.39 and Bruno Fernandes
 * 6.31 — a 0.08 gap, comfortably inside the model's own error — but Bruno's
 * chance of a double-figure return is 0.31 against Gabriel's 0.22, and his
 * ceiling is 14 against 13. On the mean alone the app recommended the Arsenal
 * defender. That is the correct answer to a question nobody asked.
 *
 * So captain value is expected points scaled by haul probability. It is
 * deliberately multiplicative and mild — a player with no realistic ceiling
 * cannot leapfrog one projecting a point more — and the raw projection is kept
 * separate and still shown, because the two answer different questions.
 */
export const CAPTAIN_UPSIDE = 0.5;

export function captainValue(p, gi) {
  if (!p) return 0;
  const mean = p.g?.[gi] ?? 0;
  const haul = p.h10 ?? 0;              // P(10+) in his best week, from the sim
  return mean * (1 + CAPTAIN_UPSIDE * haul);
}

export function bestXI(ids, gi, captId, startIds) {
  if (startIds && startIds.length === 11) {
    const pool = ids.map((i) => byId[i]).filter(Boolean);
    const xi = startIds.map((i) => byId[i]).filter(Boolean);
    if (xi.length === 11 && isLegalXI(xi)) {
      const manual = captId != null ? xi.find((p) => p.i === captId) : null;
      const auto = [...xi].sort((a, b) => captainValue(b, gi) - captainValue(a, gi))[0];
      const capt = manual || auto;
      const bench = pool.filter((p) => !startIds.includes(p.i))
        .sort((a, b) => (a.p === "GK" ? 1 : b.p === "GK" ? -1 : b.g[gi] - a.g[gi]));
      return { xi, bench, capt, autoCapt: !manual, manualXI: true, cnt: null };
    }
  }
  return autoXI(ids, gi, captId);
}

function autoXI(ids, gi, captId) {
  const pool = ids.map((i) => byId[i]).filter(Boolean);
  const sorted = [...pool].sort((a, b) => b.g[gi] - a.g[gi]);
  const xi = [];
  const cnt = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  POS_ORDER.forEach((pos) =>
    sorted.filter((p) => p.p === pos).slice(0, XI_MIN[pos]).forEach((p) => {
      xi.push(p); cnt[pos]++;
    })
  );
  for (const p of sorted) {
    if (xi.length >= 11) break;
    if (xi.includes(p) || cnt[p.p] >= XI_MAX[p.p]) continue;
    xi.push(p); cnt[p.p]++;
  }
  const manual = captId != null ? xi.find((p) => p.i === captId) : null;
  const auto = [...xi].sort((a, b) => captainValue(b, gi) - captainValue(a, gi))[0];
  const capt = manual || auto;
  const bench = pool.filter((p) => !xi.includes(p))
    .sort((a, b) => (a.p === "GK" ? 1 : b.p === "GK" ? -1 : b.g[gi] - a.g[gi]));
  return { xi, bench, capt, autoCapt: !manual, cnt };
}

// Scoring: only the starting XI counts, plus the captain doubled. The bench
// scores nothing unless Bench Boost is played.
export const gwScore = (ids, gi, captId, startIds) => {
  const { xi, capt } = bestXI(ids, gi, captId, startIds);
  return xi.reduce((s, p) => s + p.g[gi], 0) + (capt ? capt.g[gi] : 0);
};
export const benchScore = (ids, gi, startIds) =>
  bestXI(ids, gi, null, startIds).bench.reduce((s, p) => s + p.g[gi], 0);
export const xiOnly = (ids, gi, startIds) =>
  bestXI(ids, gi, null, startIds).xi.reduce((s, p) => s + p.g[gi], 0);

// Minutes eligibility. Mirrors the optimiser gate in fplab/optimize.py: below
// this many expected minutes a player cannot clear the 60-minute appearance
// point often enough to be worth a slot, however good his per-90 rates look.
export const MIN_MINUTES = DATA.min_minutes ?? 25;
export const isGated = (p) => p?.xm != null && p.xm < MIN_MINUTES;

// A stricter bar for the Value tab. Twenty-five expected minutes is the right
// gate for the optimiser — it is asking whether a player can hold a squad slot
// at all — but it is far too generous for a table headed "the best pick at this
// price". Emegha cleared it on 32 expected minutes while starting 27% of
// Chelsea's games, and Garner appeared with 75 projected points while ruled out
// injured, because expected minutes are a per-appearance average and say
// nothing about whether the appearance happens.
//
// P(start) is the honest test, and it is one gate rather than three:
// minutes.estimate already multiplies the start rate by the availability flag,
// so an injury, a rotation risk and a man behind a first choice all show up in
// the same number.
export const MIN_START_PCT = 45;
export const startsEnough = (p) => (p?.ps ?? 0) >= MIN_START_PCT;

// ---- transfer engine ------------------------------------------------------
export function bestTransfers(squad, horizon, limit = 8) {
  const ideas = [];
  const base = horizon.reduce((s, k) => s + gwScore(squad, k), 0);
  for (const outId of squad) {
    const o = byId[outId];
    if (!o) continue;
    const others = squad.filter((x) => x !== outId);
    const left = BUDGET - squadCost(others);
    const cc = clubCounts(others);
    // Never recommend a player the optimiser would refuse to select.
    const cands = DATA.players.filter((p) =>
      p.p === o.p && !others.includes(p.i) && p.c <= left + 1e-6
      && (cc[p.t] || 0) < 3 && !isGated(p));
    for (const c of cands) {
      const next = others.concat([c.i]);
      const gain = horizon.reduce((s, k) => s + gwScore(next, k), 0) - base;
      if (gain > 0.05) ideas.push({ out: o, in: c, gain });
    }
  }
  return ideas.sort((a, b) => b.gain - a.gain).slice(0, limit);
}

// ---- week-by-week planner -------------------------------------------------
// One free transfer a week, bankable to five, mirroring the real game. At each
// week we look at what a single move is worth over the REMAINING weeks, not
// just the next one — that is what makes rolling a transfer the right call so
// often. Chips are then placed on the resulting squad: Bench Boost where the
// bench is worth most, Triple Captain where the armband is worth most, Free
// Hit where your own squad is furthest below what a one-week optimal would do.
export const MAX_FT = 5;

export function planSeason(squad, { minGain = 2.0, hitGain = 6.0 } = {}) {
  const n = DATA.gws.length;
  let cur = [...squad];
  let ft = 1;
  const weeks = [];

  for (let k = 0; k < n; k++) {
    const horizon = [];
    for (let j = k; j < n; j++) horizon.push(j);

    let move = null;
    let took = "roll";
    if (ft >= 1) {
      const ideas = bestTransfers(cur, horizon, 3);
      const best = ideas[0];
      if (best && best.gain >= minGain) {
        move = best;
        took = "transfer";
      } else if (best && best.gain >= hitGain && ft === 0) {
        move = best;
        took = "hit";
      }
    }
    if (move) {
      cur = cur.map((x) => (x === move.out.i ? move.in.i : x));
      ft -= 1;
    }

    const { capt, bench } = bestXI(cur, k);
    weeks.push({
      gw: DATA.gws[k],
      k,
      squad: [...cur],
      move,
      action: took,
      ftAfter: Math.min(MAX_FT, ft + 1),
      captain: capt,
      benchPts: bench.reduce((s, p) => s + p.g[k], 0),
      xp: gwScore(cur, k),
    });
    ft = Math.min(MAX_FT, ft + 1);
  }

  // Chip placement on the planned squads.
  const bbWeek = weeks.reduce((a, b) => (b.benchPts > a.benchPts ? b : a));
  const tcWeek = weeks.reduce((a, b) =>
    ((b.captain?.g[b.k] || 0) > (a.captain?.g[a.k] || 0) ? b : a));
  const fhWeek = weeks.reduce((a, b) => {
    const gapA = (OPTIMAL[String(a.gw)]?.xp || 0) - a.xp;
    const gapB = (OPTIMAL[String(b.gw)]?.xp || 0) - b.xp;
    return gapB > gapA ? b : a;
  });

  return {
    weeks,
    total: weeks.reduce((s, w) => s + w.xp, 0),
    chips: {
      bb: { gw: bbWeek.gw, value: bbWeek.benchPts, worth: bbWeek.benchPts >= 12 },
      tc: {
        gw: tcWeek.gw,
        player: tcWeek.captain,
        value: tcWeek.captain?.g[tcWeek.k] || 0,
        worth: (tcWeek.captain?.g[tcWeek.k] || 0) >= 6,
      },
      fh: {
        gw: fhWeek.gw,
        gap: (OPTIMAL[String(fhWeek.gw)]?.xp || 0) - fhWeek.xp,
        worth: ((OPTIMAL[String(fhWeek.gw)]?.xp || 0) - fhWeek.xp) >= 15,
      },
    },
  };
}

// ---- fixture difficulty ---------------------------------------------------
// The two difficulty scales are not interchangeable. Rescaled to 1–10 across
// the whole calendar, the average ATTACKING fixture rates 6.07 and the average
// DEFENSIVE one 4.93, so a flat "5.5 is neutral" would tell every forward he is
// in for an easy season and every defender the opposite. Each scale is
// therefore standardised against its own distribution, read off the shipped
// table so a re-export cannot quietly move the zero.
const FDR_STATS = (() => {
  const stat = (xs) => {
    if (!xs.length) return { mean: 5.5, sd: 1.5 };
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
    return { mean, sd: sd || 1.5 };
  };
  const acc = { a: [], d: [] };
  Object.values(DATA.fdr || {}).forEach((f) => {
    ["a", "d"].forEach((key) =>
      (f?.[key] || []).forEach((v) => v != null && acc[key].push(v)));
  });
  return { a: stat(acc.a), d: stat(acc.d) };
})();

// How much of a position's points ride on the fixture being kind to the attack
// rather than to the defence. A keeper lives entirely on clean sheets and
// saves; a forward entirely on the opponent's back line. Defenders and
// midfielders sit between, and FPL now pays both of them for defensive work.
const ATT_SHARE = { GK: 0, DEF: 0.25, MID: 0.7, FWD: 1 };

// One player's fixture in one week, in standard deviations of difficulty.
// Positive is harder than average. Null on a blank — a blank already scores
// zero and must not also be recorded as an easy game.
export function fixtureZ(player, k) {
  const f = DATA.fdr[player?.t];
  if (!f) return null;
  const a = f.a?.[k], d = f.d?.[k];
  if (a == null && d == null) return null;
  const w = ATT_SHARE[player.p] ?? 0.5;
  const za = a == null ? 0 : (a - FDR_STATS.a.mean) / FDR_STATS.a.sd;
  const zd = d == null ? 0 : (d - FDR_STATS.d.mean) / FDR_STATS.d.sd;
  return w * za + (1 - w) * zd;
}

// The run a squad is walking into over the weeks `ks`, in standard deviations,
// weighted by how much of the squad's scoring each player carries.
//
// Two decisions here, and both matter.
//
// It reads all fifteen rather than the eleven. Measured on the eleven the
// number is worthless, because picking an eleven IS picking your kindest
// fixtures: every squad in the game, good or awful, posts a strongly negative
// figure that says nothing about the squad. The fifteen is also the honest
// subject — "my players have hard fixtures" is a fact about who you own.
//
// The weight is the player's SEASON average, not his projection for the week in
// question. A striker away at the best defence in the league already projects
// low, so weighting by the weekly projection would quietly forgive the very
// fixture being charged for.
export function fixtureDrag(ids, ks) {
  const n = DATA.gws.length || 1;
  let num = 0, den = 0;
  for (const k of ks) {
    for (const i of ids) {
      const p = byId[i];
      if (!p) continue;
      const z = fixtureZ(p, k);
      if (z == null) continue;
      const w = Math.max(0.5, (p.x || 0) / n);
      num += w * z;
      den += w;
    }
  }
  return den > 0 ? num / den : 0;
}

// Zero on this scale is not an ordinary run, it is the LEAGUE mean — and no
// real squad sits there. Good players play for good clubs, good clubs face
// weaker opponents, so every fifteen worth owning posts a comfortably negative
// figure: measured across legal squads built at a range of fixture biases, from
// fixture-chasing to fixture-blind, they land between −0.65 and −0.05 with the
// mass around −0.40. That is the ordinary run, and it is what gets charged
// from. Billing from zero instead would dock every squad in the game for
// fixtures nobody could have avoided.
const FIXTURE_NEUTRAL = -0.40;

// Difficulty above an ordinary run. One-directional by design: a kind run is
// worth points, and the score already pays for those points through the ratio.
// Paying a second time for the same fixtures would be double-counting, and it
// is what first pushed the solver's own squad past 90.
export function fixtureGap(squad, ks) {
  return Math.max(0, fixtureDrag(squad, ks) - FIXTURE_NEUTRAL);
}

export const fixtureRun = (drag) => {
  const e = drag - FIXTURE_NEUTRAL;
  return e >= 0.3 ? { label: "brutal run", tone: "bad", c: "#E90052" }
    : e >= 0.12 ? { label: "tough run", tone: "warn", c: "#F58A3C" }
    : e <= -0.15 ? { label: "kind run", tone: "good", c: "#00FF87" }
    : { label: "even run", tone: "", c: "#947CA6" };
};

// ---- squad rating --------------------------------------------------------
// Scores a squad out of 100 over three horizons, against the best legal squad
// for the same money in the same weeks.
//
// Chips change what is reachable, so they are modelled rather than hand-waved:
// a Free Hit week is played with that week's single-GW optimum, and from a
// Wildcard onward you hold the best six-week squad.
//
// Why the raw ratio is not the score
// ----------------------------------
// The ceiling is a fresh £100m optimal squad EVERY week, which no held squad
// can track. Real squads land between about 0.80 and 0.97 of it, so scoring
// the ratio directly compresses the entire meaningful range into the top fifth
// of the scale and hands out 90s for ordinary teams. The curve below stretches
// that band across the full 0–100 instead: FLOOR is the ratio worth zero, and
// GAMMA > 1 makes the last few percent — the part that separates a very good
// squad from the optimum — cost the most.
//
// A previous version also added 60% of the best available transfer to the
// numerator while leaving it out of the ceiling, which is what made 100
// reachable: a squad with a big obvious upgrade could out-score the optimum it
// was being measured against. The upside is still computed and still shown,
// but as its own number — the score now measures the squad you actually hold.
//
// Why the fixtures are charged for separately
// -------------------------------------------
// The ceiling is rebuilt every week, so it always owns the kindest fixtures
// going — which means a hard run drags your points down and the ceiling's down
// with them, and the ratio barely moves. Measured against a moving target, a
// squad walking into six weeks of top-six away days scores much the same as one
// walking into six weeks of promoted sides. That is not what anyone means by a
// good squad, so the run is charged for explicitly on top of the ratio. It is a
// penalty only, never a bonus: see fixtureGap for why crediting kind fixtures
// rewards arithmetic rather than judgement.
const HORIZONS = { now: 1, h3: 3, h6: 6 };

// Calibrated against the MEASURED distribution of legal fifteens, not chosen.
// Three populations of squads were generated against the live projections and
// scored over the same six-week window as the optimum (ratio = squad points /
// optimal points, as a percentage):
//
//     population            p5    p25    p50    p75    p95
//     random legal        30.4   40.0   45.4   50.3   58.0
//     competent value     79.6   82.8   84.8   87.4   89.5
//     near-optimal        93.2   96.1   97.5   98.5   99.9
//
// The old floor of 0.55 with gamma 1.7 mapped a 0.905 squad — better than
// every competent-value build sampled, and the work of an experienced manager
// — to 59 out of 100. That is not a harsh grade, it is a broken scale: it
// treated the entire realistic range as failure because it was anchored on a
// ratio nothing real ever reaches from below.
//
// A floor of 0.35 sits just under the random-legal band, so a thrown-together
// squad scores near zero rather than the scale wasting its bottom half on
// squads nobody would pick. Gamma 1.5 keeps the top genuinely hard to reach:
//
//     ratio 0.45 -> 6      random legal, median
//     ratio 0.85 -> 67     competent value build
//     ratio 0.90 -> 78     strong human squad
//     ratio 0.95 -> 89
//     ratio 1.00 -> 100    the optimiser itself, and nothing else
const RATING_FLOOR = 0.35;
const RATING_GAMMA = 1.5;

// Ratio charged per standard deviation of fixture difficulty above an ordinary
// run. Calibrated on real legal fifteens: most squads sit at or under the
// ordinary run and pay nothing, and one built entirely out of clubs in a bad
// patch runs about 0.35 sigma above it — a ten-point deduction at the top of
// the scale, which is what a rough six weeks is genuinely worth.
const FIXTURE_CHARGE = 0.09;

export function ratingCurve(ratio) {
  const t = (ratio - RATING_FLOOR) / (1 - RATING_FLOOR);
  return Math.round(100 * Math.pow(Math.max(0, Math.min(1, t)), RATING_GAMMA));
}

export function rateSquad(squad, capt, {
  wildcardGw = null, freeHitGw = null, benchBoostGw = null, tripleCaptainGw = null,
  gi = 0, startIds = null,
} = {}) {
  if (!squad || squad.length !== 15) return null;
  const n = DATA.gws.length;
  const wcIdx = wildcardGw != null ? DATA.gws.indexOf(wildcardGw) : -1;
  const fhIdx = freeHitGw != null ? DATA.gws.indexOf(freeHitGw) : -1;
  const bbIdx = benchBoostGw != null ? DATA.gws.indexOf(benchBoostGw) : -1;
  const tcIdx = tripleCaptainGw != null ? DATA.gws.indexOf(tripleCaptainGw) : -1;

  const weekPoints = (k) => {
    if (k === fhIdx) return OPTIMAL[String(DATA.gws[k])]?.xp ?? gwScore(squad, k, capt);
    const onWildcard = wcIdx >= 0 && k >= wcIdx;
    const ids = onWildcard ? OPTIMAL.range.squad : squad;
    const useCapt = onWildcard ? null : capt;
    // Your manual eleven applies to your own squad, not to a wildcard rebuild.
    const useStart = onWildcard ? null : startIds;
    let pts = gwScore(ids, k, useCapt, useStart);
    // Bench Boost adds the four substitutes; Triple Captain adds the armband a
    // third time. Both stack on whatever squad you hold that week.
    if (k === bbIdx) pts += benchScore(ids, k, useStart);
    if (k === tcIdx) pts += bestXI(ids, k, useCapt, useStart).capt?.g[k] || 0;
    return pts;
  };
  const ceilingPoints = (k) => OPTIMAL[String(DATA.gws[k])]?.xp
    ?? gwScore(OPTIMAL.range.squad, k);

  // What one free transfer a week could realistically add over the horizon.
  const upside = (len) => {
    const hz = []; for (let k = gi; k < Math.min(gi + len, n); k++) hz.push(k);
    if (!hz.length) return 0;
    const ideas = bestTransfers(squad, hz, 1);
    return ideas.length ? ideas[0].gain : 0;
  };

  const out = {};
  for (const [key, len] of Object.entries(HORIZONS)) {
    const ks = []; for (let k = gi; k < Math.min(gi + len, n); k++) ks.push(k);
    const mine = ks.reduce((s, k) => s + weekPoints(k), 0);
    const best = ks.reduce((s, k) => s + ceilingPoints(k), 0);
    const gain = upside(len);
    // Fixture difficulty is charged against your own fifteen, so a wildcard
    // rebuild inside the horizon does not launder a bad run.
    const drag = fixtureDrag(squad, ks);
    const ratio = best > 0 ? mine / best : 0;
    const charged = ratio - FIXTURE_CHARGE * fixtureGap(squad, ks);
    out[key] = {
      score: best > 0 ? ratingCurve(charged) : 0,
      // The same squad's score before the fixture deduction, so the UI can say
      // what the run cost rather than leaving an unexplained number.
      raw: best > 0 ? ratingCurve(ratio) : 0,
      drag,
      run: fixtureRun(drag),
      points: mine,
      ceiling: best,
      // The headline number most people actually want: how many projected
      // points this squad leaves on the table versus the perfect one.
      gap: best - mine,
      upside: gain,
      weeks: ks.map((k) => DATA.gws[k]),
    };
  }
  out.chips = { wildcardGw, freeHitGw, benchBoostGw, tripleCaptainGw };
  // Shown beside the headline, never folded into it. A manager wildcarding
  // wants to know three separate things — is it strong, can it cover a blank,
  // and can I still move — and averaging them into one number destroys exactly
  // the information they came for.
  out.depth = squadDepth(squad, gi);
  out.flex = squadFlexibility(squad);
  return out;
}

// Where each chip is worth most on the squad you actually hold — used to
// suggest a week rather than make you hunt for it.
export function bestChipWeeks(squad, capt, gi = 0) {
  if (!squad || squad.length !== 15) return null;
  const ks = DATA.gws.map((_, k) => k).filter((k) => k >= gi);
  const bench = ks.map((k) => ({ k, v: benchScore(squad, k) }))
    .sort((a, b) => b.v - a.v)[0];
  const tc = ks.map((k) => ({ k, v: bestXI(squad, k, capt).capt?.g[k] || 0 }))
    .sort((a, b) => b.v - a.v)[0];
  const fh = ks.map((k) => ({
    k, v: (OPTIMAL[String(DATA.gws[k])]?.xp ?? 0) - gwScore(squad, k, capt),
  })).sort((a, b) => b.v - a.v)[0];
  return {
    bb: bench ? { gw: DATA.gws[bench.k], value: bench.v } : null,
    tc: tc ? { gw: DATA.gws[tc.k], value: tc.v } : null,
    fh: fh ? { gw: DATA.gws[fh.k], value: fh.v } : null,
  };
}

// Bands for the curve above. Under a linear ratio almost every complete squad
// landed in "Strong" or better, which made the label useless. On the current
// curve Elite needs about 0.97 of the weekly optimum on a run of fixtures that
// is not actively hostile — a bar the solver's own six-week squad only just
// clears, which is the intended meaning of the word.
export const ratingBand = (s) =>
  s >= 88 ? { label: "Elite", c: "#00FF87" }
  : s >= 74 ? { label: "Strong", c: "#5CE88A" }
  : s >= 60 ? { label: "Solid", c: "#8BE24A" }
  : s >= 44 ? { label: "Average", c: "#F5C542" }
  : s >= 28 ? { label: "Weak", c: "#F58A3C" }
  : { label: "Rebuild", c: "#E90052" };

// Is banking the transfer worth more than playing it? A move you make this
// week costs you the option of a better move next week; under the bar it is
// usually right to roll and hold two.
export const ROLL_BAR = 2.0;
export function transferVerdict(gain, ftBanked = 1) {
  if (gain >= 6) return { take: true, tone: "good", text: `Well worth it — +${gain.toFixed(1)} clears even a −4 hit.` };
  if (gain >= 4) return { take: true, tone: "good", text: `Worth playing — +${gain.toFixed(1)} beats the −4 hit bar.` };
  if (gain >= ROLL_BAR) return { take: true, tone: "", text: `Worth a free transfer, not a hit. +${gain.toFixed(1)}.` };
  if (ftBanked >= 2) return { take: false, tone: "warn", text: `Only +${gain.toFixed(1)}, and you are already holding ${ftBanked}. Spend one or you waste the bank.` };
  return { take: false, tone: "warn", text: `Only +${gain.toFixed(1)} — roll it. Two transfers next week is worth more than this.` };
}

// Measured against the held-range optimal squad rather than the weekly optima,
// so this ratio runs higher than the rating and needs its own (tighter) cuts.
// A+ now means genuinely at the optimum, not merely close to it.
// Thresholds sit on the measured populations behind RATING_FLOOR: a
// near-optimal squad lands A, a strong human draft B, a competent value build
// C, and a thrown-together fifteen E. They were previously set against the raw
// ratio rather than the curved score, which is why every real squad graded two
// letters below what it deserved.
export function grade(pct) {
  if (pct >= 95) return { g: "A+", c: "#00FF87", t: "Elite — at or near the optimum" };
  if (pct >= 87) return { g: "A", c: "#5CE88A", t: "Very strong squad" };
  if (pct >= 76) return { g: "B", c: "#8BE24A", t: "Strong — a few upgrades available" };
  if (pct >= 62) return { g: "C", c: "#F5C542", t: "Solid, real points still on the table" };
  if (pct >= 45) return { g: "D", c: "#F58A3C", t: "Weak — consider a wildcard" };
  return { g: "E", c: "#E90052", t: "Well off the pace — wildcard territory" };
}

// ---- squad quality beyond raw points --------------------------------------
// A squad is not only its starting eleven. Two fifteens projecting the same
// points are not equally good if one has four playable substitutes and money
// in the bank and the other has a dead bench and three players from one club.
// These are scored separately and shown alongside the headline rather than
// blended into it, because they answer a different question — "how strong is
// this squad" versus "how easy is it to keep it strong".

// Expected minutes below which a bench slot cannot be relied on to come on,
// and is worth nothing at all under Bench Boost.
const PLAYABLE_MINUTES = 45;

export function squadDepth(squad, gi = 0) {
  const pool = squad.map((i) => byId[i]).filter(Boolean);
  if (pool.length !== 15) return null;
  const { bench } = bestXI(squad, gi);
  const playable = bench.filter((p) => (p.xm ?? 0) >= PLAYABLE_MINUTES);
  const benchPts = bench.reduce((s, p) => s + (p.g[gi] || 0), 0);
  // Four playable substitutes is the ceiling; a bench of non-players is zero.
  // Bench points matter too, but only for the one week Bench Boost is played,
  // so availability carries the larger share.
  const avail = playable.length / 4;
  const pts = Math.min(1, benchPts / 12);        // 12 pts across four subs is strong
  return {
    score: Math.round(100 * (0.65 * avail + 0.35 * pts)),
    playable: playable.length,
    benchPts,
  };
}

export function squadFlexibility(squad) {
  const pool = squad.map((i) => byId[i]).filter(Boolean);
  if (pool.length !== 15) return null;
  const spend = pool.reduce((s, p) => s + p.c, 0);
  const bank = Math.max(0, BUDGET - spend);
  // Clubs already at the three-player cap block any transfer into them.
  const clubs = clubCounts(squad);
  const blocked = Object.values(clubs).filter((n) => n >= 3).length;
  // Players the model expects not to play are slots that must be spent fixing.
  const dead = pool.filter((p) => (p.xm ?? 0) < MIN_MINUTES).length;

  const bankScore = Math.min(1, bank / 2.5);      // £2.5m free = full marks
  const clubScore = Math.max(0, 1 - blocked / 5); // five capped clubs = locked
  const deadScore = Math.max(0, 1 - dead / 3);
  return {
    score: Math.round(100 * (0.4 * bankScore + 0.3 * clubScore + 0.3 * deadScore)),
    bank, blocked, dead,
  };
}

// True when the viewport is wide enough to show the pitch and the transfer
// market side by side — the same 1000px breakpoint the stylesheet uses.
export function useIsWide() {
  const q = "(min-width: 1000px)";
  const [wide, setWide] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(q).matches);
  React.useEffect(() => {
    const m = window.matchMedia(q);
    const on = (e) => setWide(e.matches);
    m.addEventListener("change", on);
    setWide(m.matches);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

// Local persistence (replaces the chat-artifact window.storage shim).
export const storage = {
  async get(key) {
    const v = localStorage.getItem("fpllab:" + key);
    return v == null ? null : { value: v };
  },
  async set(key, value) {
    localStorage.setItem("fpllab:" + key, value);
  },
};

// ---- letter grades --------------------------------------------------------
// A 0-100 number is precise but not legible at a glance: nobody reads a table
// of 73/68/71 and sees the difference. Grades are anchored on the two points
// the rating scale already means something at — 50 is the template manager, so
// C is average by construction, and anything above C is beating the field.
//
// The letter is PRESENTATION. Every objective the solver optimises stays in
// points, because grades cannot be summed, discounted, or weighed against a
// -4 transfer hit. The grade is what you read; xP is what the model does.
const GRADE_BANDS = [
  [92, "A+"], [84, "A"], [78, "A−"],
  [72, "B+"], [64, "B"], [58, "B−"],
  [52, "C+"], [46, "C"], [40, "C−"],
  [28, "D"], [15, "E"], [-Infinity, "F"],
];

export function gradeFor(rating) {
  if (rating == null || !isFinite(rating)) return null;
  for (const [floor, letter] of GRADE_BANDS) if (rating >= floor) return letter;
  return "F";
}

// Grade tone for styling: how far above or below the template a thing sits.
export const gradeTone = (g) =>
  !g ? "" : g.startsWith("A") ? "elite"
    : g.startsWith("B") ? "good"
      : g.startsWith("C") ? "par" : "poor";

// ---- player grades --------------------------------------------------------
// A squad rating and a player rating are different questions. A player is
// graded against OTHERS IN HIS POSITION for the gameweek in question, because
// 4.5 points is an outstanding week for a defender and a poor one for a
// premium forward — one scale across all four positions would grade every
// goalkeeper F and tell you nothing.
//
// Only players who plausibly start are in the reference set. Grading a striker
// against 300 bench-warmers would hand an A to anyone who plays at all.
const GRADE_POOL_MIN_MINS = 45;
const _gradeCache = new Map();

function positionCurve(pos, gi) {
  const key = `${pos}:${gi}`;
  if (_gradeCache.has(key)) return _gradeCache.get(key);
  const vals = DATA.players
    .filter((p) => p.p === pos && (p.xm ?? 0) >= GRADE_POOL_MIN_MINS)
    .map((p) => (p.g ? p.g[gi] : p.x) ?? 0)
    .sort((a, b) => a - b);
  _gradeCache.set(key, vals);
  return vals;
}

/** Percentile-based 0-100 rating for one player in one gameweek. */
export function playerRating(p, gi) {
  const vals = positionCurve(p.p, gi);
  if (!vals.length) return null;
  const v = (p.g ? p.g[gi] : p.x) ?? 0;
  let lo = 0;
  while (lo < vals.length && vals[lo] < v) lo++;
  return (lo / vals.length) * 100;
}

export const playerGrade = (p, gi) => gradeFor(playerRating(p, gi));


// A whole SQUAD's gameweek score on the 0-100 scale, so it can carry the same
// letter grades as an individual player.
//
// Anchored on what a squad actually returns rather than on an abstract range:
// the template manager's fifteen scores about 51 in a normal week and the best
// squad money can buy about 63, which are the two numbers the squad rating
// already uses. Below 40 and above 75 are real but rare, so the scale is
// clamped rather than stretched to accommodate them.
const WEEK_FIELD = 51, WEEK_CEILING = 63;
export const weekRating = (pts) =>
  Math.max(0, Math.min(100, 50 + 50 * ((pts - WEEK_FIELD) / (WEEK_CEILING - WEEK_FIELD))));
