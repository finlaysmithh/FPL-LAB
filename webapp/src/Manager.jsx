import React from "react";
import { DATA, bestXI, benchScore, isGated, money, validate } from "./logic.js";

/**
 * The gaffer. Touchline-worn, permanently unimpressed, quietly on your side.
 * Drawn rather than emoji so he sits in the same visual language as the kits.
 */
export function ManagerAvatar({ size = 54, mood = "ok" }) {
  const brow = mood === "bad" ? 3 : mood === "good" ? -2 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="gaffer">
      <defs>
        <linearGradient id="coat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d1b4a" />
          <stop offset="1" stopColor="#2a0f35" />
        </linearGradient>
      </defs>
      {/* padded touchline coat */}
      <path d="M12 64 V48c0-7 5-11 11-12l9-2 9 2c6 1 11 5 11 12v16Z" fill="url(#coat)" />
      <path d="M32 34l-7 4 7 22 7-22Z" fill="#1c0026" opacity="0.8" />
      <path d="M23 36c-6 1-11 5-11 12v16h6V48c0-4 2-8 5-10Z" fill="#00FF87" opacity="0.22" />
      {/* scarf */}
      <path d="M22 37c6 4 14 4 20 0l2 5c-8 5-16 5-24 0Z" fill="#00FF87" opacity="0.85" />
      {/* neck + head */}
      <rect x="28" y="28" width="8" height="8" rx="3" fill="#e8b48c" />
      <ellipse cx="32" cy="20" rx="12" ry="13" fill="#f0c19a" />
      {/* close-cropped hair + touchline stubble */}
      <path d="M20 17c1-8 7-12 12-12s11 4 12 12c-3-4-7-6-12-6s-9 2-12 6Z" fill="#4a3a33" />
      <path d="M22 24c2 5 6 8 10 8s8-3 10-8c-1 6-5 10-10 10s-9-4-10-10Z" fill="#4a3a33" opacity="0.35" />
      {/* eyes, brows carry the mood */}
      <circle cx="27" cy="20" r="1.7" fill="#2b1a12" />
      <circle cx="37" cy="20" r="1.7" fill="#2b1a12" />
      <path d={`M23.5 ${16 + brow}h6`} stroke="#4a3a33" strokeWidth="1.8" strokeLinecap="round" />
      <path d={`M34.5 ${16 + brow}h6`} stroke="#4a3a33" strokeWidth="1.8" strokeLinecap="round" />
      {/* mouth reads the verdict */}
      {mood === "good"
        ? <path d="M28 26q4 3.5 8 0" stroke="#8a4b3a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        : mood === "bad"
          ? <path d="M28 27q4-3.5 8 0" stroke="#8a4b3a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          : <path d="M28 26.5h8" stroke="#8a4b3a" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * Advice is generated from the squad in front of him, never canned: every line
 * below only appears when the thing it describes is actually true.
 */
export function buildAdvice({ squad, capt, gi, rating, topTransfer, verdict }) {
  const lines = [];
  const { xi, capt: captP, autoCapt } = bestXI(squad, gi, capt);
  const gw = DATA.gws[gi];

  const errs = validate(squad);
  if (errs.length) {
    lines.push({ tone: "bad", text: `That squad is not legal yet — ${errs.join(", ")}. Sort that before anything else.` });
  }

  // Availability is the first thing a manager checks.
  const crocked = xi.filter((p) => p.st && p.st !== "d");
  const doubts = xi.filter((p) => p.st === "d");
  if (crocked.length) {
    lines.push({ tone: "bad", text: `${crocked.map((p) => p.n).join(" and ")} ${crocked.length > 1 ? "are" : "is"} ruled out and still in your XI. That is a guaranteed zero — move ${crocked.length > 1 ? "them" : "him"}.` });
  } else if (doubts.length) {
    lines.push({ tone: "warn", text: `${doubts.map((p) => p.n).join(", ")} carrying a knock. Have a plan B ready by deadline.` });
  }

  // Captaincy.
  if (captP) {
    const vice = [...xi].filter((p) => p !== captP).sort((a, b) => b.g[gi] - a.g[gi])[0];
    const edge = vice ? captP.g[gi] - vice.g[gi] : 0;
    if (!autoCapt && edge < -0.05) {
      lines.push({ tone: "warn", text: `You have got the armband on ${captP.n}, but ${vice.n} projects higher this week. Your call — just know what it costs.` });
    } else if (edge < 0.3 && vice) {
      lines.push({ tone: "", text: `${captP.n} and ${vice.n} are line-ball for the armband. Coin toss — I would back the one at home.` });
    } else {
      // `edge`, not his total: "6.3 clear of the rest" was reporting the
      // captain's own projection as though it were the margin over the vice.
      lines.push({ tone: "good", text: `${captP.n} is the obvious armband on ${captP.g[gi].toFixed(1)}, ${edge.toFixed(1)} clear of ${vice ? vice.n : "the rest"}.` });
    }
  }

  // The transfer decision.
  if (topTransfer && verdict) {
    lines.push({
      tone: verdict.take ? "good" : "warn",
      text: `${verdict.take ? "Do it" : "Sit tight"}: ${topTransfer.out.n} out, ${topTransfer.in.n} in. ${verdict.text}`,
    });
  } else {
    lines.push({ tone: "", text: "Nothing out there improves this lot right now. Bank the transfer — two next week is worth more than a poor one today." });
  }

  // Deadwood.
  const dead = squad.map((i) => DATA.players.find((p) => p.i === i)).filter((p) => p && isGated(p));
  if (dead.length >= 2) {
    lines.push({ tone: "warn", text: `${dead.length} of your fifteen barely play — ${dead.slice(0, 2).map((p) => p.n).join(", ")}. Fine as bench filler, but you cannot afford an injury.` });
  }

  // Where the rating actually sits, stated in points rather than in a score
  // out of 100 — the gap is the thing you can do something about.
  if (rating) {
    const now = rating.now.score, six = rating.h6.score;
    if (six > now + 6) {
      lines.push({ tone: "good", text: `Rough week ahead, but the fixtures turn — you rate ${now} now and ${six} across the six. Hold your nerve.` });
    } else if (now > six + 6) {
      lines.push({ tone: "warn", text: `Good this week (${now}) and thinner later (${six}). Start planning the rebuild now, not in three weeks.` });
    }
    const gap = rating.h6?.gap ?? 0;
    if (gap > 25) {
      lines.push({ tone: "warn", text: `Over the next six you are ${gap.toFixed(0)} points behind a perfect squad. That is wildcard money, not a transfer.` });
    } else if (gap > 12) {
      lines.push({ tone: "", text: `You are ${gap.toFixed(0)} points off a perfect six weeks. Two or three good transfers close most of that — no need to tear it up.` });
    } else if (gap > 0.5) {
      lines.push({ tone: "good", text: `Only ${gap.toFixed(0)} points off the perfect six weeks. There is not much left on the table — stop tinkering.` });
    }
    // The rating is docked for the run you are walking into, so say so rather
    // than leaving an unexplained number on the card.
    const run = rating.h6?.run;
    const cost = (rating.h6?.raw ?? 0) - (rating.h6?.score ?? 0);
    if (run && (run.tone === "warn" || run.tone === "bad") && cost >= 1) {
      lines.push({
        tone: run.tone,
        text: `Your rating is docked ${cost} for the fixtures — this lot are into a ${run.tone === "bad" ? "brutal" : "tough"} six weeks. On an ordinary run the same fifteen rates ${rating.h6.raw}.`,
      });
    } else if (run && run.tone === "good") {
      lines.push({ tone: "good", text: "The fixtures are with your fifteen over the six. Take the points now — the run does not last, and the rating will not flatter you when it turns." });
    }
  }

  // Money doing nothing. Bank sitting idle is the most common quiet leak in a
  // squad: it is not saved for later, it is simply not playing.
  const spend = squad.reduce((s, i) => s + (DATA.players.find((p) => p.i === i)?.c || 0), 0);
  const bank = 100 - spend;
  if (bank >= 1.5) {
    lines.push({ tone: "warn", text: `You are sitting on £${bank.toFixed(1)}m. That money scores nothing in the bank — spend it or you are playing with fourteen and a half players.` });
  }

  // Fixture swing over the next three, read off the same difficulty ratings the
  // projections use. Names the clubs, because "bad fixtures" is not advice.
  const swing = {};
  xi.forEach((p) => {
    const a = DATA.fdr[p.t]?.a || [];
    const run = a.slice(gi, gi + 3).filter((v) => v != null);
    if (run.length) swing[p.t] = run.reduce((s, v) => s + v, 0) / run.length;
  });
  const rough = Object.entries(swing).filter(([, v]) => v >= 6.5).map(([t]) => t);
  const kind = Object.entries(swing).filter(([, v]) => v <= 3.2).map(([t]) => t);
  const list = (xs) => (xs.length === 2 ? `${xs[0]} and ${xs[1]}` : xs.join(", "));
  if (rough.length >= 2) {
    const r = rough.slice(0, 3);
    lines.push({ tone: "warn", text: `${list(r)} ${r.length === 2 ? "both" : "all"} have a hard three weeks. You are heavily exposed to one bad run of fixtures.` });
  } else if (kind.length >= 3) {
    lines.push({ tone: "good", text: `${list(kind.slice(0, 3))} are into a soft run. Hold them through it before you think about selling.` });
  }

  // Squad shape. Five defenders you never start is five players doing nothing.
  const benchXI = bestXI(squad, gi, capt).bench.filter((p) => p.p !== "GK");
  const deadBench = benchXI.filter((p) => p.g[gi] < 2.0);
  if (deadBench.length >= 3) {
    lines.push({ tone: "warn", text: `Three of your four substitutes project under two points. That bench cannot cover an injury, and Bench Boost is worthless while it looks like that.` });
  }

  // Bench.
  const bench = benchScore(squad, gi);
  if (bench > 14) {
    lines.push({ tone: "good", text: `${bench.toFixed(1)} points sat on your bench this week. That is Bench Boost territory if you still have it.` });
  }

  // Ordered so the things that lose points outright come first: an illegal
  // squad or a ruled-out starter beats a fixture observation every time.
  const rank = { bad: 0, warn: 1, "": 2, good: 3 };
  return lines.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 7);
}

export function ManagerCard({ advice, score }) {
  // Re-cut for the harsher curve: 82 used to be an ordinary squad and is now a
  // very good one, so the same brow would have him permanently unimpressed.
  const mood = score == null ? "ok" : score >= 76 ? "good" : score < 50 ? "bad" : "ok";
  const verdict = mood === "good" ? "Happy enough."
    : mood === "bad" ? "We need to talk." : "Room to improve.";
  return (
    <div className="gaffer-card">
      <div className="gaffer-head">
        <ManagerAvatar mood={mood} />
        <div>
          <div className="gaffer-name">The Gaffer</div>
          <div className={`gaffer-verdict ${mood}`}>{verdict}</div>
        </div>
      </div>
      <ul className="gaffer-list">
        {advice.map((a, k) => (
          <li key={k} className={a.tone}>{a.text}</li>
        ))}
      </ul>
    </div>
  );
}
