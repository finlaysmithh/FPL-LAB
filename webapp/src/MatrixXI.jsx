import React, { useMemo, useState } from "react";
import {
  DATA, OPTIMAL, byId, fdrColor, fdrInk, fdrLabel, fixtureAt, money,
} from "./logic.js";
import { managerBriefing, pPlay, weekQuality } from "./manager.js";
import { Jersey } from "./components.jsx";
import { Pitch } from "./Pitch.jsx";

/**
 * THE MATRIX XI — the model's own team, managed in public.
 *
 * Every other page grades YOUR squad. This one commits to a team and takes the
 * consequences, which is the only way a model can be wrong in a way anybody can
 * check. A page that only ever marks other people's homework is never wrong,
 * and never wrong is not the same as right.
 *
 * So it is laid out as a command desk rather than an article: the decision
 * first, the team beside its own reasoning, the season underneath. Every number
 * comes from the same engine that drives My Squad — if this page and that page
 * ever disagreed, one of them would be lying.
 */

const GI = 0;
const GW = DATA.gws[GI];

const POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

function Fx({ team, gi }) {
  const f = fixtureAt(team, gi);
  if (!f) return <span className="mxd-fx blank">BLANK</span>;
  return (
    <span className="mxd-fx" style={{ background: fdrColor(f.fdr), color: fdrInk(f.fdr) }}
      title={`${f.home ? "Home to" : "Away at"} ${f.opp} — ${fdrLabel(f.fdr)}`}>
      {f.opp}<i>{f.home ? "H" : "A"}</i>
    </span>
  );
}

function SheetRow({ p, gi, role, sub }) {
  const q = Math.round(pPlay(p) * 100);
  return (
    <div className={`mxd-r ${role ? "is-" + role : ""}`}>
      <span className="mxd-r-badge">
        {role === "capt" ? "C" : role === "vice" ? "V" : sub != null ? sub : ""}
      </span>
      <Jersey team={p.t} size={21} />
      <span className="mxd-r-n">{p.n}</span>
      <span className="mxd-r-p">{p.p}</span>
      <Fx team={p.t} gi={gi} />
      <span className="mxd-r-x">{p.g[gi].toFixed(1)}</span>
      <span className={`mxd-r-m ${q >= 90 ? "ok" : q >= 70 ? "mid" : "low"}`}>{q}%</span>
    </div>
  );
}

export function MatrixXITab() {
  const squad = OPTIMAL.range.squad;
  const [tab, setTab] = useState("sheet");

  const brief = useMemo(() => managerBriefing(squad, GI, { free: 1, span: 6 }), []);
  const q = useMemo(() => weekQuality(squad, GI), []);
  if (!brief) return <div className="page">Loading…</div>;

  const s = brief.sheet;
  const t = brief.transfers;
  const cost = squad.reduce((a, i) => a + (byId[i]?.c || 0), 0);
  const xiSorted = [...s.xi].sort(
    (a, b) => POS_ORDER[a.p] - POS_ORDER[b.p] || b.g[GI] - a.g[GI]);

  // The chip with something to say, if any.
  const chipRows = Object.entries(brief.chips)
    .map(([k, c]) => ({ k, ...c }))
    .sort((a, b) => (b.worth - a.worth) || a.best.gw - b.best.gw);

  return (
    <div className="page mxd">

      {/* ---- masthead ------------------------------------------------- */}
      <header className="mxd-top">
        <div className="mxd-id">
          <span className="mxd-eyebrow">The Matrix XI</span>
          <h1>The model's own team</h1>
          <p>
            Not a grade on yours — a squad it commits to, with the reasoning
            attached. Same engine as My Squad, so the two can never disagree.
          </p>
        </div>
        <div className="mxd-stats">
          <div className="mxd-stat">
            <span>GW{GW} projected</span>
            <b className="g">{s.ev.toFixed(1)}</b>
          </div>
          <div className="mxd-stat">
            <span>Shape</span><b>{s.formation}</b>
          </div>
          <div className="mxd-stat">
            <span>Spent</span><b>{money(cost)}</b>
          </div>
          {q?.score != null && (
            <div className="mxd-stat">
              <span>Quality</span>
              <b style={{ color: q.band.c }}>{q.score}<i>/100</i></b>
            </div>
          )}
        </div>
      </header>

      {/* ---- the call ------------------------------------------------- */}
      <div className={`mxd-call c-${t.verdict.toLowerCase()}`}>
        <span className="mxd-call-k">GW{GW}</span>
        <div className="mxd-call-b">
          <b>{brief.summary[0]}</b>
          <p>{t.why[0]}</p>
        </div>
        <span className="mxd-call-c">{Math.round(brief.confidence * 100)}%<i>confidence</i></span>
      </div>

      {/* ---- the desk: pitch | sheet | reasoning ---------------------- */}
      <div className="mxd-desk">

        <section className="mxd-pitch">
          <Pitch ids={squad} gi={GI} sheet={s} readOnly />
        </section>

        <section className="mxd-panel">
          <div className="mxd-tabs" role="tablist">
            {[["sheet", "Team sheet"], ["why", "Reasoning"], ["chips", "Chips"]].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k}
                className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === "sheet" && (
            <div className="mxd-sheet">
              {xiSorted.map((p) => (
                <SheetRow key={p.i} p={p} gi={GI}
                  role={p.i === s.capt.i ? "capt" : p.i === s.vice.i ? "vice" : null} />
              ))}
              <div className="mxd-sub-k">Bench — in the order they come on</div>
              {s.bench.map((p, i) => (
                <SheetRow key={p.i} p={p} gi={GI} sub={i === 0 ? "GK" : i} />
              ))}
            </div>
          )}

          {tab === "why" && (
            <div className="mxd-why">
              {s.captainWhy.map((w, i) => (
                <p key={i}><span className="mxd-why-k">Armband</span>{w}</p>
              ))}
              {s.benchWhy.map((w, i) => (
                <p key={i}><span className="mxd-why-k">Bench</span>{w}</p>
              ))}
              {s.shapeWhy?.text && (
                <p><span className="mxd-why-k">Shape</span>{s.shapeWhy.text}</p>
              )}
              {s.tieBreaks.map((x, i) => (
                <p key={i}><span className="mxd-why-k warn">Close</span>{x.why}</p>
              ))}
              <div className="mxd-maths">
                <span>Eleven <b>{s.parts.base.toFixed(1)}</b></span>
                <span>Autosub cover <b>+{s.parts.cover.toFixed(2)}</b></span>
                <span>Armband <b>+{s.parts.armband.toFixed(1)}</b></span>
                <span className="tot">Expected <b>{s.ev.toFixed(1)}</b></span>
              </div>
            </div>
          )}

          {tab === "chips" && (
            <div className="mxd-chips">
              {chipRows.map((c) => (
                <div key={c.k} className={`mxd-chip ${c.worth ? "on" : ""}`}>
                  <div className="mxd-chip-t">
                    <b>{c.title}</b>
                    <span>{c.worth ? `GW${c.best.gw}` : "hold"}</span>
                  </div>
                  <p>{c.why}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ---- the season ----------------------------------------------- */}
      <section className="mxd-road">
        <h2>The plan · GW{brief.plan[0].gw}–{brief.plan[brief.plan.length - 1].gw}</h2>
        <div className="mxd-road-row">
          {brief.plan.map((r) => (
            <div key={r.gw} className={`mxd-stop ${r.gw === GW ? "now" : ""}`}>
              <div className="mxd-stop-h">
                GW{r.gw}{r.isBreak && <i title="Follows an international break">break</i>}
              </div>
              <div className="mxd-stop-n">{r.pts.toFixed(0)}</div>
              <div className="mxd-stop-c">{r.capt.n}</div>
              <div className="mxd-stop-f">{r.formation} · {r.ft} FT</div>
              {r.chip && <div className="mxd-stop-chip">{r.chip.title}</div>}
              {r.swing.slice(0, 1).map((sw, i) => (
                <div key={i} className={`mxd-stop-sw ${sw.dir}`}>{sw.team} {sw.dir}</div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <p className="mxd-foot">
        Rebuilt from the model before each deadline. Where it changes its mind,
        the reason is on this page — including the weeks it gets it wrong.
      </p>
    </div>
  );
}
