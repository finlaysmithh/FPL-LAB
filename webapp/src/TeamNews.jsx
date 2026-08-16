import React, { useMemo, useState } from "react";
import NOTES from "../team-notes.json";
import { DATA, POS_ORDER, fdrColor, fdrInk, isGated, money } from "./logic.js";
import { KITS, TEAM_NAMES } from "./kits.js";
import { FixtureStrip, Jersey, NextFixture, availInfo } from "./components.jsx";
import { PitchSvg } from "./Pitch.jsx";

const TEAMS = Object.keys(TEAM_NAMES).sort((a, b) =>
  TEAM_NAMES[a].localeCompare(TEAM_NAMES[b]));

// The XI the model expects, from projected minutes rather than reputation.
// Shape is whatever the squad supports: take the nailed keeper, then fill
// 4-4-2 and let the best remaining players take the spare shirts.
function expectedXI(team) {
  const pool = DATA.players
    .filter((p) => p.t === team && !p.st)
    .sort((a, b) => (b.xm ?? 0) - (a.xm ?? 0) || b.x - a.x);
  const xi = { GK: [], DEF: [], MID: [], FWD: [] };
  const chosen = new Set();
  const fill = (pos, n) => {
    for (const p of pool) {
      if (xi[pos].length >= n) break;
      if (p.p !== pos || chosen.has(p.i)) continue;
      xi[pos].push(p); chosen.add(p.i);
    }
  };
  fill("GK", 1); fill("DEF", 4); fill("MID", 4); fill("FWD", 2);
  // (see predictedBench below for the substitutes half of this)

  // A club short of fit bodies in one position (Liverpool with a single
  // available forward) would otherwise show a ten-man side. Top up with the
  // next best available outfielders, within legal shape limits.
  const cap = { DEF: 5, MID: 5, FWD: 3 };
  for (const p of pool) {
    if (chosen.size >= 11) break;
    if (p.p === "GK" || chosen.has(p.i) || xi[p.p].length >= cap[p.p]) continue;
    xi[p.p].push(p); chosen.add(p.i);
  }
  return xi;
}

// Who a summer arrival is squeezing. A signing threatens the incumbents in his
// own position who project fewer minutes than he does — that is the real
// competition, not simply "expensive player joined".
/**
 * The seven substitutes, which is what a real teamsheet names.
 *
 * Deliberately NOT "everyone else": a 25-man squad contains academy players and
 * fourth-choice keepers who will not be involved, and listing them buries the
 * three or four names that actually matter. So this takes the best seven by
 * how likely they are to be on the pitch at all, and drops anyone the model
 * gives essentially no chance — with one exception, the backup keeper, who is
 * always named on a real bench even at 3%.
 */
function predictedBench(team, startingIds, size = 7) {
  const rest = DATA.players
    .filter((p) => p.t === team && !startingIds.has(p.i) && !(p.st && p.st !== "d"))
    .map((p) => ({ ...p, involve: (p.ps ?? 0) + (p.p60 ?? 0) * 0.5 }))
    .sort((a, b) => b.involve - a.involve || b.x - a.x);

  const gk = rest.find((p) => p.p === "GK");
  const outfield = rest.filter((p) => p.p !== "GK" && (p.ps ?? 0) >= 4);
  const bench = gk ? [gk, ...outfield] : outfield;
  return bench.slice(0, size);
}

/**
 * Chance this player is involved at all, and how. `ps` is the model's start
 * probability; a non-starter still has a real chance off the bench, which the
 * five-substitute rule has made much more valuable than it used to be.
 */
function involvement(p) {
  const start = p.ps ?? 0;
  const mins = p.xm ?? 0;
  if (start >= 80) return { label: "Nailed", tone: "nailed" };
  if (start >= 55) return { label: "Likely", tone: "likely" };
  if (start >= 30) return { label: "Rotation risk", tone: "risk" };
  if (mins >= 8) return { label: "Impact sub", tone: "sub" };
  return { label: "Squad", tone: "fringe" };
}

function threatened(team) {
  const squad = DATA.players.filter((p) => p.t === team);
  const rows = [];
  for (const s of squad.filter((p) => p.ns === 1 && (p.xm ?? 0) >= 45)) {
    const rivals = squad
      .filter((p) => p.p === s.p && p.i !== s.i && p.ns !== 1 && (p.xm ?? 0) > 20)
      .sort((a, b) => (b.xm ?? 0) - (a.xm ?? 0))
      .filter((p) => (p.xm ?? 0) <= (s.xm ?? 0) + 15)
      .slice(0, 2);
    if (rivals.length) rows.push({ signing: s, rivals });
  }
  return rows;
}

export function TeamNewsTab({ gi }) {
  const [team, setTeam] = useState("ARS");
  const kit = KITS[team] || {};
  const note = NOTES.teams?.[team] || {};
  const xi = useMemo(() => expectedXI(team), [team]);
  const squad = useMemo(() => DATA.players.filter((p) => p.t === team), [team]);

  const doubts = squad.filter((p) => p.st).sort((a, b) => (b.xm ?? 0) - (a.xm ?? 0));
  const pens = squad.filter((p) => p.pk > 0).sort((a, b) => a.pk - b.pk);
  const threats = useMemo(() => threatened(team), [team]);
  const fdr = DATA.fdr[team];
  const avg = fdr ? fdr.a.reduce((s, v) => s + (v || 5), 0) / fdr.a.length : null;
  const hasNote = note.headline || note.manager || note.watch || note.penalties;

  return (
    <div className="page">
      <div className="eyebrow">Team news</div>
      <p className="page-blurb">
        Twenty club pages. The expected XI, injury flags, penalty order and
        squad competition are read straight from the data and refresh with the
        model. The written notes are yours to keep current.
      </p>

      {/* Club picker: every side in its own kit, so you navigate by shirt. */}
      <div className="club-grid" role="tablist" aria-label="Club">
        {TEAMS.map((t) => (
          <button key={t} role="tab" aria-selected={t === team}
            className={`club-chip ${t === team ? "on" : ""}`}
            style={t === team ? { borderColor: KITS[t]?.b, background: `${KITS[t]?.b}22` } : undefined}
            onClick={() => setTeam(t)} title={TEAM_NAMES[t]}>
            <Jersey team={t} size={26} />
            <span>{t}</span>
          </button>
        ))}
      </div>

      {/* The club's own kit colours carry the page — each of the twenty reads
          as that club rather than as a generic panel. */}
      <div className="club-head" style={{
        background: `linear-gradient(115deg, ${kit.b}2e, transparent 62%)`,
        borderColor: `${kit.b}55`,
      }}>
        <Jersey team={team} size={44} />
        <div className="club-title">
          <h2>{TEAM_NAMES[team]}</h2>
          <div className="club-sub">
            {DATA.promoted.includes(team) && <span className="new-tag">PROMOTED</span>}
            {squad.length} registered · next {DATA.gws.length} GWs rank
            {avg != null && <b> {avg.toFixed(1)} difficulty</b>}
          </div>
        </div>
        <div className="club-fx">
          <NextFixture team={team} gi={gi} />
          <FixtureStrip team={team} gi={gi} />
        </div>
      </div>

      {note.updated && <div className="note-stamp">Your notes last updated {note.updated}</div>}
      {note.headline && <div className="club-headline">{note.headline}</div>}

      <div className="club-cols">
        <div>
          <div className="section-title">Expected XI</div>
          <div className="pitch-wrap">
            <PitchSvg />
            <div className="pitch-rows">
              {POS_ORDER.map((pos) => (
                <div key={pos} className="pitch-row">
                  {xi[pos].map((p) => {
                    const av = availInfo(p);
                    return (
                      <div key={p.i} className="tn-slot" title={p.nw || undefined}>
                        <Jersey team={team} size={30} />
                        <span className="tn-name">{p.n}</span>
                        <span className="tn-mins">
                          {Math.round(p.xm ?? 0)}′ · {money(p.c)}
                        </span>
                        {/* Confidence bar, not a tick: a predicted XI is a set
                            of probabilities and showing it as certainty is the
                            single most misleading thing this page could do. */}
                        {p.ps != null && (
                          <span className="tn-conf" title={`${p.ps}% chance of starting`}>
                            <span className={`tn-conf-fill ${involvement(p).tone}`}
                              style={{ width: `${Math.max(3, p.ps)}%` }} />
                            <i>{p.ps}%</i>
                          </span>
                        )}
                        {p.pk > 0 && <span className="tn-pen">P{p.pk}</span>}
                        {av && <span className={`tn-flag ${av.tone}`} />}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <p className="footnote">
            Picked on projected minutes, not reputation — this is who the model
            thinks starts, which is why it sometimes disagrees with the pundits.
            The bar under each name is his chance of starting, not a guarantee.
          </p>

          <div className="section-title">Likely bench</div>
          <ul className="tn-bench">
            {predictedBench(team, new Set(POS_ORDER.flatMap((q) => xi[q].map((p) => p.i)))).map((p) => {
              const inv = involvement(p);
              return (
                <li key={p.i} className="tn-sub" title={p.nw || undefined}>
                  <Jersey team={team} size={24} />
                  <span className="tn-sub-name">
                    {p.n}
                    <em>{p.p} · {money(p.c)}</em>
                  </span>
                  <span className="tn-sub-bar">
                    <span className={`tn-conf-fill ${inv.tone}`}
                      style={{ width: `${Math.max(3, p.ps ?? 0)}%` }} />
                  </span>
                  <span className="tn-sub-pct">{p.ps ?? 0}%</span>
                  <span className={`tn-sub-tag ${inv.tone}`}>{inv.label}</span>
                </li>
              );
            })}
          </ul>
          <p className="footnote">
            Seven substitutes, the way a real teamsheet names them — ranked by
            how likely each is to get on the pitch. Academy and fourth-choice
            players are left out on purpose; the backup keeper is always listed
            even at a few percent, because a bench always carries one.
          </p>
        </div>

        <div>
          <div className="section-title">Penalties</div>
          <div className="card">
            {pens.length ? (
              <ol className="pen-list">
                {pens.map((p) => (
                  <li key={p.i}>
                    <span className="pen-ord">{p.pk}</span>
                    <span className="pen-name">{p.n}</span>
                    <span className="pen-meta">{money(p.c)} · {Math.round(p.xm ?? 0)}′</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="page-blurb" style={{ margin: 0 }}>
                No taker listed by FPL. Players here are credited zero penalty
                xG until one is — the model never splits spot-kicks on a hunch.
              </p>
            )}
            {note.penalties && <p className="note-body pen-note">{note.penalties}</p>}
          </div>

          <div className="section-title">Fitness</div>
          <div className="card">
            {doubts.length ? doubts.map((p) => {
              const av = availInfo(p);
              return (
                <div key={p.i} className="fit-row">
                  <span className={`tag ${av.tone}`}>{av.label}</span>
                  <div className="fit-body">
                    <div className="fit-name">{p.n} <span>{p.p} · {money(p.c)}</span></div>
                    {p.nw && <div className="fit-news">{p.nw}</div>}
                  </div>
                </div>
              );
            }) : (
              <p className="page-blurb" style={{ margin: 0 }}>
                Nobody flagged. FPL publishes most knocks close to the deadline,
                so check again nearer kick-off.
              </p>
            )}
          </div>

          <div className="section-title">Places under threat</div>
          <div className="card">
            {threats.length ? threats.map(({ signing, rivals }) => (
              <div key={signing.i} className="threat-row">
                <div className="threat-in">
                  <Jersey team={team} size={22} />
                  <b>{signing.n}</b>
                  <span>{signing.pc ? `from ${TEAM_NAMES[signing.pc] || signing.pc}` : "new in"} · {money(signing.c)}</span>
                </div>
                <div className="threat-out">
                  pressures {rivals.map((r) => r.n).join(" and ")}
                  <span> — {rivals.map((r) => `${Math.round(r.xm ?? 0)}′`).join(", ")} projected</span>
                </div>
              </div>
            )) : (
              <p className="page-blurb" style={{ margin: 0 }}>
                No summer arrival is projected to displace anyone here.
              </p>
            )}
          </div>

          {(note.manager || note.watch) && (
            <>
              <div className="section-title">From the club</div>
              <div className="card">
                {note.manager && <blockquote className="mgr-quote">{note.manager}</blockquote>}
                {note.watch && <p className="note-body">{note.watch}</p>}
              </div>
            </>
          )}

          {!hasNote && (
            <div className="card note-empty">
              <b>No notes yet for {TEAM_NAMES[team]}.</b>
              <p>
                Everything above is live from the data. To add a headline, a
                manager quote or your own read on the minutes battle, edit
                <code>webapp/team-notes.json</code> under <code>"{team}"</code>
                {" "}and rebuild. Nothing gets written there unless you write it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
