import React, { useMemo, useState } from "react";
import { DATA, FDR_BANDS, fdrColor, fdrInk, fdrLabel } from "./logic.js";
import { TEAM_NAMES } from "./kits.js";
import { Jersey } from "./components.jsx";

const N = DATA.gws.length;
const WINDOWS = [3, 5, 6, 8, 10, N];

/**
 * Three readings of the same calendar, because "a good run" means different
 * things depending on what you own.
 *
 *   attack   how easy it is for THAT club's forwards to score
 *   defence  how likely THAT club is to keep a clean sheet
 *   quality  how strong the opponents are, full stop — no credit for being
 *            good yourself, which is the only way a promoted side can top the
 *            table on a genuinely soft run
 */
const VIEWS = [
  { k: "attack", label: "Attacking returns",
    blurb: "How hard it is for this club's attackers to score. Low is good — buy their forwards and attacking midfielders." },
  { k: "defence", label: "Clean sheets",
    blurb: "How likely this club is to keep it tight. Low is good — buy their defenders and keeper." },
  { k: "quality", label: "Opponent quality",
    blurb: "Purely how strong the opposition is, with no credit for the club's own ability. A promoted side can top this table if the calendar is kind — it says nothing about whether they will win." },
];

/**
 * The team model, shown rather than hidden.
 *
 * Every player projection in the app is downstream of these twenty numbers, so
 * they are the fastest way to sanity-check whether the engine's view of the
 * league is defensible. If the model has Arsenal fourth and a promoted side
 * third, no amount of player-level cleverness underneath is going to save it.
 *
 * Computed exactly over the bivariate-Poisson scoreline matrix — the same
 * distribution the match simulation samples from, without the Monte Carlo
 * error. Win / draw / loss are summed across the projected horizon.
 */
function TeamModel() {
  const [open, setOpen] = useState(false);
  const sim = DATA.team_sim;
  if (!sim) return null;
  const rows = Object.entries(sim)
    .map(([t, v]) => ({ t, ...v }))
    .sort((a, b) => b.pts - a.pts);
  const maxPts = Math.max(...rows.map((r) => r.pts), 1);
  const shown = open ? rows : rows.slice(0, 6);

  return (
    <div className="tm-wrap">
      <div className="tm-head">
        <span className="tm-title">Projected table</span>
        <span className="tm-sub">
          GW{DATA.gws[0]}–{DATA.gws[DATA.gws.length - 1]} · simulated from the fixture model
        </span>
      </div>
      <div className="tm-legend">
        <span><i className="tm-sw w" />win</span>
        <span><i className="tm-sw d" />draw</span>
        <span><i className="tm-sw l" />loss</span>
        <span className="tm-legend-r">xPts · clean sheets · goals for/against</span>
      </div>
      {shown.map((r, i) => {
        // Horizon-average win/draw/loss shares, which is what the stacked bar
        // is showing — not a single fixture.
        const played = r.gw.filter(Boolean);
        const n = played.length || 1;
        const w = played.reduce((s, g) => s + g.w, 0) / n;
        const d = played.reduce((s, g) => s + g.d, 0) / n;
        const l = Math.max(0, 1 - w - d);
        return (
          <div key={r.t} className="tm-row">
            <span className="tm-rank">{i + 1}</span>
            <Jersey team={r.t} size={20} />
            <span className="tm-club">{r.t}</span>
            <div className="tm-bar" title={`${(w * 100).toFixed(0)}% win · ${(d * 100).toFixed(0)}% draw · ${(l * 100).toFixed(0)}% loss`}>
              <div className="w" style={{ width: `${w * 100}%` }} />
              <div className="d" style={{ width: `${d * 100}%` }} />
              <div className="l" style={{ width: `${l * 100}%` }} />
            </div>
            <span className="tm-pts">{r.pts.toFixed(0)}</span>
            <span className="tm-cs">{r.cs.toFixed(1)}</span>
            <span className="tm-gd">{r.gf.toFixed(0)}/{r.ga.toFixed(0)}</span>
          </div>
        );
      })}
      <button className="tm-more" onClick={() => setOpen((v) => !v)}>
        {open ? "Show top six only" : `Show all ${rows.length} clubs`}
      </button>
    </div>
  );
}

export function FixturesTab({ gi }) {
  const [view, setView] = useState("attack");
  const [win, setWin] = useState(6);

  const start = Math.min(gi, Math.max(0, N - win));
  const meta = VIEWS.find((v) => v.k === view);

  // Opponent quality: rank every club by how good its opponents are, using the
  // difficulty the OPPONENT presents to an average side. We approximate a club's
  // own strength by how hard others find it to score against them across the
  // whole half-season, then read the calendar off that.
  const oppStrength = useMemo(() => {
    const s = {};
    for (const [t, f] of Object.entries(DATA.fdr)) {
      // Mean difficulty this club imposes = how often OTHER clubs, facing them,
      // are rated a hard fixture. Derived from every entry naming them.
      let sum = 0, n = 0;
      for (const [, of_] of Object.entries(DATA.fdr)) {
        of_.o.forEach((opp, k) => {
          if (String(opp).toUpperCase() === t && of_.a[k] != null) { sum += of_.a[k]; n++; }
        });
      }
      s[t] = n ? sum / n : 5;
    }
    return s;
  }, []);

  const rows = useMemo(() => {
    return Object.entries(DATA.fdr).map(([t, f]) => {
      const idx = [];
      for (let k = start; k < Math.min(start + win, N); k++) idx.push(k);
      const vals = idx.map((k) => {
        if (view === "attack") return f.a[k] ?? 5;
        // The model rates every fixture twice; `d` is the defensive half.
        if (view === "defence") return f.d?.[k] ?? 5;
        return oppStrength[String(f.o[k] || "").toUpperCase()] ?? 5;
      });
      const avg = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
      return { t, f, idx, vals, avg };
    }).sort((a, b) => (view === "quality" ? b.avg - a.avg : a.avg - b.avg));
  }, [view, win, start, oppStrength]);

  return (
    <div className="page">
      <div className="eyebrow">Fixtures</div>
      <p className="page-blurb">{meta.blurb}</p>

      <TeamModel />

      <div className="fx-controls">
        <div className="seg fx-seg">
          {VIEWS.map((v) => (
            <button key={v.k} className={`seg-btn ${view === v.k ? "on" : ""}`}
              onClick={() => setView(v.k)}>{v.label}</button>
          ))}
        </div>
        <div className="chip-row fx-win">
          <span className="chip-label">Next</span>
          {WINDOWS.map((w) => (
            <button key={w} className={`chip ${win === w ? "on" : ""}`}
              onClick={() => setWin(w)}>{w === N ? "All 19" : w}</button>
          ))}
        </div>
      </div>

      <div className="legend">
        {FDR_BANDS.map(([hi, c, label]) => (
          <span key={label}><span className="sw" style={{ background: c }} />{label}</span>
        ))}
        <span className="legend-caps">CAPS = home · lower-case = away</span>
      </div>

      <div className="fx-scroll">
        <table className="fx-table">
          <thead>
            <tr>
              <th>Club</th>
              {rows[0]?.idx.map((k) => <th key={k}>{DATA.gws[k]}</th>)}
              <th>Avg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, f, idx, vals, avg }, rank) => (
              <tr key={t}>
                <td>
                  <span className="fx-team" title={TEAM_NAMES[t]}>
                    <span className="fx-rank">{rank + 1}</span>
                    <Jersey team={t} size={17} />
                    {t}
                    {DATA.promoted.includes(t) && <span className="new-tag">NEW</span>}
                  </span>
                </td>
                {idx.map((k, j) => (
                  <td key={k}>
                    <div className="fx-box" style={{
                      background: fdrColor(vals[j]), color: fdrInk(vals[j]),
                      outline: k === gi ? "1.5px solid rgba(255,255,255,.8)" : "none",
                      outlineOffset: "-1.5px",
                    }} title={`GW${DATA.gws[k]} · ${fdrLabel(vals[j])} · difficulty ${vals[j].toFixed(1)}`}>
                      {f.o[k]}
                    </div>
                  </td>
                ))}
                <td className="fx-avg">{avg.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="footnote">
        {view === "quality"
          ? "Sorted hardest run first, so the clubs at the top face the strongest opposition over the window. This is opponent strength only — a promoted side high in this table has a brutal calendar, not a good team."
          : `Sorted easiest run first over the next ${win === N ? 19 : win} gameweeks from GW${DATA.gws[start]}. Change the window to find who is worth buying before their run turns.`}
      </p>
    </div>
  );
}
