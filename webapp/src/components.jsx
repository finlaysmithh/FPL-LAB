import React from "react";
import { KITS } from "./kits.js";
import {
  DATA, HORIZON_BANDS, bestXI, fdrColor, fdrInk, fdrLabel, fixtureAt,
  gradeTone, horizonBand, horizonError, horizonLabel, money, playerGrade,
} from "./logic.js";

// ---- club jersey ----------------------------------------------------------
export function Jersey({ team, size = 38 }) {
  const k = KITS[team] || { b: "#64748b", s: "#e2e8f0", p: "solid" };
  const id = `k${team}`;
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true" className="jersey">
      <defs>
        <clipPath id={id}>
          <path d="M13 5 L22 9 L31 5 L42 12 L37.5 20 L34 18 V40 H10 V18 L6.5 20 L2 12 Z" />
        </clipPath>
        {k.p === "stripes" && (
          <pattern id={id + "s"} width="7" height="1" patternUnits="userSpaceOnUse">
            <rect width="7" height="1" fill={k.b} />
            <rect width="3.5" height="1" fill={k.s} />
          </pattern>
        )}
        <linearGradient id={id + "g"} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.18" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id})`}>
        <rect x="0" y="0" width="44" height="44"
          fill={k.p === "stripes" ? `url(#${id}s)` : k.b} />
        {k.p === "claretbody" && <rect x="0" y="0" width="18" height="44" fill={k.s} />}
        {k.p === "sleeves" && (
          <>
            <rect x="0" y="8" width="9" height="16" fill={k.s} />
            <rect x="35" y="8" width="9" height="16" fill={k.s} />
          </>
        )}
        <rect x="0" y="0" width="44" height="44" fill={`url(#${id}g)`} />
      </g>
      <path d="M13 5 L22 9 L31 5 L28.5 11 L22 13.5 L15.5 11 Z" fill={k.s} opacity="0.92" />
      <path d="M13 5 L22 9 L31 5 L42 12 L37.5 20 L34 18 V40 H10 V18 L6.5 20 L2 12 Z"
        fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

// Availability: i/s/u = out (red), d = doubtful (amber, with % when known).
export const availInfo = (p) => {
  if (!p.st) return null;
  if (p.st === "d") return { tone: "doubt", label: p.ch != null ? `${p.ch}%` : "50%" };
  return { tone: "out", label: "OUT" };
};

// This gameweek's opponent and venue, FPL-style: BOU (H).
// The colour repeats the difficulty the strip below already shows, but the
// text is what actually carries it — difficulty must never be colour alone.
export function NextFixture({ team, gi, compact }) {
  const fx = fixtureAt(team, gi);
  if (!fx) {
    return <span className="fx-next blank" title="No fixture — blank gameweek">BLANK</span>;
  }
  return (
    <span className={`fx-next ${compact ? "sm" : ""}`}
      style={{ background: fdrColor(fx.fdr), color: fdrInk(fx.fdr) }}
      title={`GW${DATA.gws[gi]}: ${fx.home ? "home to" : "away at"} ${fx.opp}`}>
      {fx.opp}<i>{fx.home ? "H" : "A"}</i>
    </span>
  );
}

// ---- player card on the pitch --------------------------------------------
export function Shirt({ p, gi, isCapt, isVice, onClick, small, state }) {
  const av = availInfo(p);
  const fx = fixtureAt(p.t, gi);
  return (
    <button onClick={onClick} disabled={!onClick}
      className={`shirt-btn ${state ? `is-${state}` : ""}`}
      style={{ width: small ? 56 : 62 }}
      aria-label={`${p.n}, ${p.p}, ${money(p.c)}, ${p.g[gi].toFixed(1)} projected points${
        fx ? `, ${fx.home ? "home to" : "away at"} ${fx.opp}` : ", blank gameweek"
      }${av ? `, availability ${av.label}` : ""}`}>
      {/* Grade as a corner mark, not a fourth figure in the points row.
          The plate is 62px wide and already carries a name, a score and a
          price; adding the grade inline pushed the content to 71px and cropped
          the price on a phone. It sits opposite the armband, where the eye
          scans the shape rather than reads the numbers. */}
      <span className={`shirt-grade g-${gradeTone(playerGrade(p, gi))}`}
        title={`Position grade this gameweek — A+ is the top of the ${p.p} pool`}>
        {playerGrade(p, gi)}
      </span>
      {isCapt && <span className="badge c">C</span>}
      {isVice && <span className="badge v">V</span>}
      {p.pk === 1 && <span className="badge p" title="Penalty taker">P</span>}
      <Jersey team={p.t} size={small ? 32 : 38} />
      <div className="plate" title={p.nw || undefined}>
        {av && <span className={`plate-flag ${av.tone}`} aria-hidden="true" />}
        <div className="nm">{p.n}</div>
        <div className="pts">
          <span className="xp" title="Projected points this gameweek">{p.g[gi].toFixed(1)}</span>
          {/* A bare "12.0" beside a points figure reads as more points. Carry
              the unit so the two numbers can never be confused. */}
          {/* No "m" suffix here. The pound sign already says it is money, and
              on a 62px shirt plate that one glyph was the difference between
              the points figure fitting and being clipped on a real iPhone —
              iOS renders this text wider than the emulator does, so the fix
              has to be slack in the layout, not a measurement that happens to
              pass on one device. */}
          <span className="pr" title={`Price ${money(p.c)}`}>£{p.c.toFixed(1)}</span>
        </div>
      </div>
      <NextFixture team={p.t} gi={gi} compact={small} />
      {(() => {
        // The next five, from where you are. All nineteen turned every shirt
        // into a barcode and swallowed the pitch.
        //
        // These were 4px dots at 40% opacity, which is a decoration rather than
        // a reading: five faded pinpricks cannot be compared against each other
        // at a glance, and the whole reason they sit under the shirt is that a
        // player's run should be legible without leaving the pitch. Full-height
        // bars at full opacity, with only the current week outlined rather than
        // the rest dimmed.
        const f = DATA.fdr[p.t];
        const a = f?.a || [];
        const from = Math.min(gi, Math.max(0, a.length - 5));
        const next = a.map((v, j) => [v, j]).slice(from, from + 5);
        return (
          <div className="fdr-run"
            title={next.map(([v, j]) =>
              `GW${DATA.gws[j]} ${String(f.o[j]).toUpperCase()} ${
                String(f.o[j]) === String(f.o[j]).toUpperCase() ? "(H)" : "(A)"} — ${fdrLabel(v)}`
            ).join("\n")}>
            {next.map(([v, j]) => (
              <span key={j} className={`fdr-bar ${j === gi ? "now" : ""}`}
                style={{ background: fdrColor(v) }} />
            ))}
          </div>
        );
      })()}
    </button>
  );
}

// ---- fixture strip --------------------------------------------------------
// The next few games from wherever you are, not the whole half-season. Nineteen
// boxes under every player buries the pitch; five tells you what you need.
export function FixtureStrip({ team, gi, count = 5 }) {
  const f = DATA.fdr[team];
  if (!f) return null;
  const from = Math.min(gi, Math.max(0, f.a.length - count));
  const slice = f.a.map((v, k) => [v, k]).slice(from, from + count);
  return (
    <div className="fx-strip">
      {slice.map(([v, k]) => (
        <div key={k} className="fx-cell"
          title={`GW${DATA.gws[k]}: ${String(f.o[k]) === String(f.o[k]).toUpperCase() ? "home to" : "away at"} ${String(f.o[k]).toUpperCase()}`}
          style={{
          background: fdrColor(v), color: fdrInk(v),
          outline: k === gi ? "1.5px solid #fff" : "none",
          outlineOffset: "-1.5px",
        }}>
          {String(f.o[k]).slice(0, 3).toUpperCase()}
        </div>
      ))}
    </div>
  );
}

// ---- gameweek picker ------------------------------------------------------
export function GwPicker({ gi, setGi, values, window: win, lock }) {
  // How many gameweeks to show is a decision for the PAGE, not this component.
  //
  // My Squad shows six, because a squad is a thing you hold for a few weeks and
  // nineteen pills is a barcode. The Optimiser shows the lot, because choosing
  // a window IS the question that page asks — capping it there removed the
  // ability to ask for GW9-14 at all.
  const SHOWN = Math.max(1, Math.min(win || DATA.gws.length, DATA.gws.length));
  const start = SHOWN >= DATA.gws.length
    ? 0
    : Math.max(0, Math.min(gi - 2, DATA.gws.length - SHOWN));
  const slice = DATA.gws.slice(start, start + SHOWN);
  return (
    <div className="gw-picker" role="tablist" aria-label="Gameweek">
      {slice.map((g, k) => {
        const idx = start + k;
        const state = lock ? lock(idx) : null;
        return (
          <button key={g} role="tab" aria-selected={idx === gi}
            className={`gw-pill band-${horizonBand(idx)} ${idx === gi ? "on" : ""}`
              + (state === "locked" ? " is-locked" : "")}
            onClick={() => setGi(idx)}
            title={`GW${g} — ${horizonLabel(idx)}`}>
            <span className="g">GW{g}</span>
            {values && <span className="v">{values[idx]}</span>}
            {state === "locked" && <span className="gw-lockmark" aria-label="Locked">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- stat tiles -----------------------------------------------------------
export function Tiles({ items }) {
  return (
    <div className="tiles">
      {items.map(([k, n, tone], j) => (
        <div key={j} className="tile">
          <div className="k">{k}</div>
          <div className={`n ${tone || ""}`}>{n}</div>
        </div>
      ))}
    </div>
  );
}

// ---- captain bar ----------------------------------------------------------
export function CaptainBar({ ids, gi, captId }) {
  const { xi, capt, autoCapt } = bestXI(ids, gi, captId);
  const vice = [...xi].filter((p) => p !== capt).sort((a, b) => b.g[gi] - a.g[gi])[0];
  if (!capt) return null;
  const edge = vice ? capt.g[gi] - vice.g[gi] : 0;
  return (
    <div className="capt-bar">
      <span className="capt-badge">C</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="capt-name">
          {capt.n} <span>· {capt.t}{autoCapt ? "" : " · your pick"}</span>
        </div>
        <div className="capt-sub">
          {capt.g[gi].toFixed(1)} × 2 = <b>{(capt.g[gi] * 2).toFixed(1)} pts</b>
          {vice && ` · ${edge < -0.05 ? `${vice.n} projects higher` : edge < 0.3 ? `close call over ${vice.n} (V)` : `clear of ${vice.n} (V)`}`}
        </div>
        {/* Ceiling and floor from the match simulation, doubled like the
            armband is. An expectation is the wrong number to captain on: you
            are picking once, for one week, and what matters is the shape of
            the outcome rather than its mean. The simulation already produces
            this distribution and it used to be thrown away. */}
        {(capt.hi != null || capt.flr != null) && (
          <div className="capt-range">
            <span className="capt-range-bar" aria-hidden="true">
              <i style={{
                left: `${Math.max(0, Math.min(100, ((capt.flr ?? 0) * 2 / 30) * 100))}%`,
                right: `${100 - Math.max(0, Math.min(100, ((capt.hi ?? 0) * 2 / 30) * 100))}%`,
              }} />
            </span>
            <span className="capt-range-t">
              floor <b>{((capt.flr ?? 0) * 2).toFixed(0)}</b>
              {" · "}ceiling <b>{((capt.hi ?? 0) * 2).toFixed(0)}</b>
              {capt.h10 != null && <> · hauls {Math.round(capt.h10 * 100)}% of weeks</>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- XI / captain / bench breakdown --------------------------------------
export function Breakdown({ xi, capt, bench, total, gw, benchCounts, tripled }) {
  return (
    <div className="card flat breakdown">
      <div className="row"><span>Starting XI</span><span className="val">{xi.toFixed(1)}</span></div>
      <div className="row">
        <span>Captain {tripled ? "tripled" : "doubled"}</span>
        <span className="val gold">+{(tripled ? capt * 2 : capt).toFixed(1)}</span>
      </div>
      <div className={`row ${benchCounts ? "" : "muted"}`}>
        <span>Bench {benchCounts ? "(Bench Boost — counts)" : "(scores nothing)"}</span>
        <span className={`val ${benchCounts ? "gold" : ""}`}>
          {benchCounts ? "+" : ""}{bench.toFixed(1)}
        </span>
      </div>
      <div className="row total"><span>GW{gw} total</span><span className="val">{total}</span></div>
    </div>
  );
}
