import React, { useMemo, useState } from "react";
import { DATA, POS_ORDER, isGated, money } from "./logic.js";
import { TEAM_NAMES } from "./kits.js";
import { Jersey } from "./components.jsx";

// Categorical hues for the four positions, validated against this app's dark
// purple chart surface (#2b0a36): lightness band, chroma floor, colour-vision
// separation and contrast all pass. Position is always labelled as well, so
// identity never rests on colour alone.
const POS_COLOR = { GK: "#3987e5", DEF: "#d95926", MID: "#199e70", FWD: "#9085e9" };

const N_GW = DATA.gws.length;

// Each metric names what it measures and, more usefully, what it is FOR.
const METRICS = [
  { k: "x", label: "Projected points", unit: "pts",
    get: (p) => p.x, fmt: (v) => v.toFixed(1),
    blurb: `Total expected points across GW${DATA.gws[0]}–${DATA.gws[N_GW - 1]}. The raw answer to "who scores most".` },
  { k: "ppm", label: "Points per £m", unit: "pts/£m",
    get: (p) => p.x / p.c, fmt: (v) => v.toFixed(1),
    blurb: "Points divided by price. The enabler metric — how hard each million works, which is what frees money for premiums elsewhere." },
  { k: "goals", label: "Goal threat", unit: "xG",
    get: (p) => p.xg ?? 0, fmt: (v) => v.toFixed(1),
    blurb: "Expected goals over the horizon, fixture-adjusted. Shot volume and quality, not finishing luck." },
  { k: "creative", label: "Creativity", unit: "xA",
    get: (p) => p.xa ?? 0, fmt: (v) => v.toFixed(2),
    blurb: "Expected assists. Who creates the chances — the metric that separates a genuine playmaker from a goalscorer." },
  { k: "ga", label: "Goals + assists per £m", unit: "xGI/£m",
    get: (p) => ((p.xg ?? 0) + (p.xa ?? 0)) / p.c, fmt: (v) => v.toFixed(2),
    blurb: "Attacking involvement per million. Finds cheap players doing expensive players' work." },
  { k: "cs", label: "Clean sheet points", unit: "pts",
    get: (p) => p.ccs ?? 0, fmt: (v) => v.toFixed(1),
    blurb: "Points expected from clean sheets alone. The defensive half of a defender's return, driven by fixtures." },
  { k: "bonus", label: "Bonus magnets", unit: "pts",
    get: (p) => p.cbp ?? 0, fmt: (v) => v.toFixed(1),
    blurb: "Expected bonus points. High-BPS players quietly out-earn their goal involvement over a season." },
  { k: "defcon", label: "Defensive contribution", unit: "pts",
    get: (p) => p.cdc ?? 0, fmt: (v) => v.toFixed(1),
    blurb: "Points from hitting the DefCon threshold — tackles, blocks, interceptions, recoveries. Rewards busy defenders and holding midfielders." },
  { k: "mins", label: "Nailed on", unit: "mins",
    get: (p) => p.xm ?? 0, fmt: (v) => Math.round(v).toString(),
    // Goalkeepers are excluded: a first-choice keeper plays 90 minutes by
    // definition, so twelve of them tie at the top and the leaderboard stops
    // answering the question it exists for, which is which OUTFIELD pick is
    // secure.
    exclude: (p) => p.p === "GK",
    blurb: "Projected minutes a game, outfield only. The single biggest driver of points, and the first thing to check on any cheap pick." },

  // From the match simulation (2,000 runs per fixture). An expected value has
  // no shape, and FPL decisions depend on shape: captaincy is a bet on a
  // ceiling, a bench slot is a bet on a floor. Sarr and Raya both project
  // about 4.2 points a game — Sarr hauls one week in four, Raya never.
  { k: "ceiling", label: "Ceiling", unit: "pts",
    get: (p) => p.hi ?? 0, fmt: (v) => v.toFixed(0),
    blurb: "The 90th-percentile single gameweek across 2,000 simulated matches — a realistic best week, not a fantasy one. This is the number captaincy actually turns on." },
  { k: "haul", label: "Haul chance", unit: "P(10+)",
    get: (p) => (p.h10 ?? 0) * 100, fmt: (v) => v.toFixed(0) + "%",
    blurb: "Chance of a double-figure return in his best week of the horizon. Two players on identical expected points can differ threefold here, and that gap is the whole captaincy decision." },
  { k: "returns", label: "Return rate", unit: "P(6+)",
    get: (p) => (p.h6 ?? 0) * 100, fmt: (v) => v.toFixed(0) + "%",
    blurb: "How often he clears six points in a typical week. The consistency metric — high return rate with a low ceiling is a set-and-forget pick, not a captain." },
  { k: "vol", label: "Volatility", unit: "sd",
    get: (p) => p.sd ?? 0, fmt: (v) => v.toFixed(2),
    blurb: "Standard deviation of simulated weekly points. High volatility is not bad in itself — it is what you are buying when you captain a premium, and what you are avoiding when you pick a keeper." },
];

function useFiltered(pos, includeGated) {
  return useMemo(() => {
    let l = DATA.players.filter((p) => (pos === "ALL" ? true : p.p === pos));
    if (!includeGated) l = l.filter((p) => !isGated(p) && !p.st);
    return l;
  }, [pos, includeGated]);
}

/* ---- horizontal bars: magnitude, one series, so one hue ---------------- */
function BarChart({ rows, metric, max }) {
  const [hover, setHover] = useState(null);
  if (!rows.length) return <p className="ch-empty">Nothing matches these filters.</p>;
  return (
    <div className="ch-bars" onMouseLeave={() => setHover(null)}>
      {rows.map((p, i) => {
        const v = metric.get(p);
        const pct = max > 0 ? (v / max) * 100 : 0;
        return (
          <div key={p.i} className={`ch-bar-row ${hover === p.i ? "hov" : ""}`}
            onMouseEnter={() => setHover(p.i)}>
            <span className="ch-rank">{i + 1}</span>
            <span className="ch-label" title={`${p.n} · ${TEAM_NAMES[p.t] || p.t}`}>
              {p.n}<em>{p.t}</em>
            </span>
            <div className="ch-track">
              <div className="ch-fill" style={{
                width: `${Math.max(pct, 1.5)}%`,
                background: POS_COLOR[p.p],
              }} />
            </div>
            <span className="ch-val">{metric.fmt(v)}</span>
            <span className="ch-price">{money(p.c)}</span>
            {hover === p.i && (
              <div className="ch-tip" role="tooltip">
                <b>{p.n}</b> · {TEAM_NAMES[p.t] || p.t} · {p.p}
                <span>{metric.fmt(v)} {metric.unit} · {money(p.c)} · {Math.round(p.xm ?? 0)}′ a game</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---- price against points: the value frontier -------------------------- */
function ValueScatter({ rows, gi }) {
  const [hover, setHover] = useState(null);
  const W = 720, H = 360, PAD = { l: 44, r: 16, t: 14, b: 34 };
  const xs = rows.map((p) => p.c), ys = rows.map((p) => p.x);
  const xMin = Math.floor(Math.min(...xs) - 0.5), xMax = Math.ceil(Math.max(...xs) + 0.5);
  // Two continuous variables, so the y-axis frames the data rather than forcing
  // zero — a bar chart would have to start at zero, a scatter would only waste
  // half its height doing so.
  const yLo = Math.floor(Math.min(...ys) / 10) * 10;
  const yMax = Math.ceil(Math.max(...ys, 1) / 10) * 10;
  const px = (c) => PAD.l + ((c - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const py = (v) => H - PAD.b - ((v - yLo) / (yMax - yLo)) * (H - PAD.t - PAD.b);

  // The frontier: the best player available at or below each price.
  const sorted = [...rows].sort((a, b) => a.c - b.c);
  const frontier = [];
  let best = -1;
  for (const p of sorted) {
    if (p.x > best) { best = p.x; frontier.push(p); }
  }

  const xTicks = [], step = xMax - xMin > 9 ? 2 : 1;
  for (let c = Math.ceil(xMin); c <= xMax; c += step) xTicks.push(c);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yLo + f * (yMax - yLo));

  return (
    <div className="ch-scatter-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="ch-scatter" role="img"
        aria-label="Price plotted against projected points, coloured by position">
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={py(v)} y2={py(v)} className="ch-grid" />
            <text x={PAD.l - 7} y={py(v) + 3.5} className="ch-axis" textAnchor="end">{Math.round(v)}</text>
          </g>
        ))}
        {xTicks.map((c) => (
          <text key={c} x={px(c)} y={H - PAD.b + 15} className="ch-axis" textAnchor="middle">{c}</text>
        ))}
        <text x={(W - PAD.l) / 2 + PAD.l} y={H - 3} className="ch-axis-title" textAnchor="middle">Price (£m)</text>

        {/* Frontier first, so points sit above it. */}
        <path d={frontier.map((p, i) => `${i ? "L" : "M"}${px(p.c)},${py(p.x)}`).join("")}
          className="ch-frontier" />

        {rows.map((p) => (
          <circle key={p.i} cx={px(p.c)} cy={py(p.x)} r={hover?.i === p.i ? 7 : 4.5}
            fill={POS_COLOR[p.p]} className="ch-dot"
            onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
        ))}
        {hover && (
          <g pointerEvents="none">
            <circle cx={px(hover.c)} cy={py(hover.x)} r="8.5" className="ch-dot-ring" />
          </g>
        )}
      </svg>
      <div className="ch-legend">
        {POS_ORDER.map((k) => (
          <span key={k}><i style={{ background: POS_COLOR[k] }} />{k}</span>
        ))}
        <span className="ch-legend-note"><i className="line" />best available at each price</span>
      </div>
      {hover && (
        <div className="ch-scatter-tip">
          <b>{hover.n}</b> {TEAM_NAMES[hover.t] || hover.t} · {hover.p} · {money(hover.c)}
          {" — "}{hover.x.toFixed(1)} pts, {(hover.x / hover.c).toFixed(1)} per £m
        </div>
      )}
    </div>
  );
}

export function PlayerChartsTab({ gi }) {
  const [metricKey, setMetricKey] = useState("ppm");
  const [pos, setPos] = useState("ALL");
  const [includeGated, setIncludeGated] = useState(false);
  const [topN, setTopN] = useState(20);

  const metric = METRICS.find((m) => m.k === metricKey) || METRICS[0];
  const pool = useFiltered(pos, includeGated);
  // `metric.exclude` lets a leaderboard drop players the question does not
  // apply to — currently goalkeepers on "Nailed on", where every first choice
  // is 90 minutes by definition and a dozen of them tie at the top.
  const rows = useMemo(
    () => pool.filter((p) => !metric.exclude?.(p))
      .sort((a, b) => metric.get(b) - metric.get(a)).slice(0, topN),
    [pool, metric, topN]);
  const max = rows.length ? metric.get(rows[0]) : 0;

  const scatterPool = useMemo(
    () => [...pool].sort((a, b) => b.x - a.x).slice(0, 140), [pool]);

  return (
    <div className="page">
      <div className="eyebrow">Player charts</div>
      <p className="page-blurb">
        Every projection broken into the parts that make it. Goals, creativity,
        clean sheets, bonus and defensive work are separate levers in FPL, and a
        player who is expensive on one can be a bargain on another.
      </p>

      <div className="ch-controls">
        <div className="chip-row">
          {["ALL", ...POS_ORDER].map((k) => (
            <button key={k} className={`chip ${pos === k ? "on" : ""}`}
              onClick={() => setPos(k)}>{k === "ALL" ? "All" : k}</button>
          ))}
        </div>
        <label className="mk-toggle">
          <input type="checkbox" checked={includeGated}
            onChange={(e) => setIncludeGated(e.target.checked)} />
          Include injured &amp; fringe
        </label>
      </div>

      <div className="section-title">The value frontier</div>
      <div className="card ch-card">
        <p className="ch-blurb">
          Price against projected points. The line traces the best player you can
          get at each price — anyone well below it is paying for something the
          model cannot see, and anyone on it is the efficient pick at that money.
        </p>
        <ValueScatter rows={scatterPool} gi={gi} />
      </div>

      <div className="section-title">Leaderboards</div>
      <div className="ch-metric-row">
        {METRICS.map((m) => (
          <button key={m.k} className={`ch-metric ${metricKey === m.k ? "on" : ""}`}
            onClick={() => setMetricKey(m.k)}>{m.label}</button>
        ))}
      </div>

      <div className="card ch-card">
        <div className="ch-head">
          <div>
            <h3>{metric.label}</h3>
            <p className="ch-blurb">{metric.blurb}</p>
          </div>
          <div className="ch-topn">
            {[10, 20, 40].map((n) => (
              <button key={n} className={`chip ${topN === n ? "on" : ""}`}
                onClick={() => setTopN(n)}>Top {n}</button>
            ))}
          </div>
        </div>
        <BarChart rows={rows} metric={metric} max={max} />
      </div>

      <p className="footnote">
        Bars are coloured by position and labelled with it in the tooltip, never
        by colour alone. Injured and sub-{DATA.min_minutes}-minute players are
        hidden by default — a cheap player who never starts tops a per-£m table
        for the wrong reason.
      </p>
    </div>
  );
}
