import React from "react";
import { POS_ORDER, bestXI, benchScore, byId, formationName } from "./logic.js";
import { Shirt } from "./components.jsx";

/* Broadcast-style vertical pitch: goal at the top, halfway line at the foot.
   Real markings — penalty area, six-yard box, D-arc, spots, corner arcs —
   over mown stripes, floodlight falloff and a whisper of grass grain. */
export function PitchSvg() {
  const W = 400, H = 560;
  const line = "rgba(255,255,255,0.62)";
  return (
    <svg className="pitch-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2fa35c" />
          <stop offset="0.5" stopColor="#25904e" />
          <stop offset="1" stopColor="#187a3f" />
        </linearGradient>
        <radialGradient id="flood" cx="0.5" cy="0" r="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#0b2a14" stopOpacity="0.5" />
        </linearGradient>
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer><feFuncA type="linear" slope="0.06" /></feComponentTransfer>
          <feComposite operator="over" in2="SourceGraphic" />
        </filter>
      </defs>

      {/* turf */}
      <rect width={W} height={H} fill="url(#grass)" />
      {/* mown stripes */}
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect key={i} x="0" y={i * 80} width={W} height="40" fill="#ffffff" opacity="0.055" />
      ))}
      {/* grain */}
      <rect width={W} height={H} filter="url(#grain)" opacity="0.5" />

      {/* markings */}
      <g fill="none" stroke={line} strokeWidth="2.2">
        {/* goal frame behind the line */}
        <rect x="160" y="13" width="80" height="13" strokeWidth="1.6" opacity="0.8" />
        <path d="M166 13 V26 M172 13 V26 M178 13 V26 M184 13 V26 M190 13 V26 M196 13 V26 M202 13 V26 M208 13 V26 M214 13 V26 M220 13 V26 M226 13 V26 M232 13 V26"
          strokeWidth="0.7" opacity="0.5" />
        {/* boundary + halfway */}
        <path d={`M18 552 V26 H382 V552`} />
        <line x1="18" y1="545" x2="382" y2="545" />
        {/* centre circle straddling the halfway line */}
        <circle cx="200" cy="545" r="55" />
        <circle cx="200" cy="545" r="2.6" fill={line} stroke="none" />
        {/* penalty area */}
        <rect x="89" y="26" width="222" height="88" />
        <rect x="145" y="26" width="110" height="32" />
        <circle cx="200" cy="85" r="2.6" fill={line} stroke="none" />
        {/* the D */}
        <path d="M161.3 114 A49 49 0 0 0 238.7 114" />
        {/* corner arcs */}
        <path d="M18 36 A10 10 0 0 0 28 26" />
        <path d="M372 26 A10 10 0 0 0 382 36" />
      </g>

      {/* light + depth */}
      <rect width={W} height={H} fill="url(#flood)" />
      <rect width={W} height={H} fill="url(#shade)" />
    </svg>
  );
}

export function Pitch({
  ids, gi, captId, onTap, readOnly, startIds,
  subSel, onSubTap, legalTargets, onCancelSub, benchBoost, sheet,
}) {
  // `sheet` is a fully decided team sheet from the manager engine — eleven,
  // bench IN ORDER, captain and vice. When it is supplied nothing here is
  // recomputed, because the bench order and the vice are real decisions there
  // and re-deriving them from raw projections would quietly overrule them.
  const auto = sheet ? null : bestXI(ids, gi, captId, startIds);
  const xi = sheet ? sheet.xi : auto.xi;
  const bench = sheet ? sheet.bench : auto.bench;
  const capt = sheet ? sheet.capt : auto.capt;
  const vice = sheet
    ? sheet.vice
    : [...xi].filter((p) => p !== capt).sort((a, b) => b.g[gi] - a.g[gi])[0];
  const rows = POS_ORDER.map((pos) => xi.filter((p) => p.p === pos));
  const benchPts = sheet
    ? bench.reduce((s, p) => s + p.g[gi], 0)
    : benchScore(ids, gi, startIds);
  const subbing = subSel != null;

  const shirtProps = (p) => {
    if (!subbing) return { onClick: readOnly ? undefined : () => onTap && onTap(p) };
    if (p.i === subSel) return { state: "selected", onClick: onCancelSub };
    if (legalTargets?.has(p.i)) return { state: "target", onClick: () => onSubTap(p) };
    return { state: "dim", onClick: undefined };
  };

  return (
    <div>
      {subbing && (
        <div className="sub-bar" role="status">
          <span>Pick who swaps with <b>{byId[subSel]?.n}</b>. Only legal shapes are lit.</span>
          <button onClick={onCancelSub}>Cancel</button>
        </div>
      )}

      <div className={`pitch-wrap ${subbing ? "subbing" : ""}`}>
        <PitchSvg />
        <div className="pitch-rows">
          {rows.map((row, ri) => (
            <div key={ri} className="pitch-row">
              {row.map((p) => (
                <Shirt key={p.i} p={p} gi={gi}
                  isCapt={capt && p.i === capt.i}
                  isVice={vice && p.i === vice.i}
                  {...shirtProps(p)} />
              ))}
            </div>
          ))}
        </div>
        <div className="pitch-shape">{formationName(xi)}</div>
      </div>

      <div className={`dugout ${benchBoost ? "boosted" : ""}`}>
        <div className="dugout-head">
          <div className="t">Substitutes</div>
          <div className="s">
            {benchBoost
              ? <><b>Bench Boost on</b> — all four count, {benchPts.toFixed(1)} pts added</>
              : <>score 0 unless Bench Boost — {benchPts.toFixed(1)} pts sitting here</>}
          </div>
        </div>
        {/* The reserve keeper sits first, apart from the outfield order. He is
            not "fourth in line" — he can only ever replace one player, so
            numbering him alongside the three who actually compete for the same
            slots was describing a queue that does not exist. Outfield subs keep
            1-2-3, which is the order they genuinely come on in. */}
        <div className="dugout-row">
          {(() => {
            const gk = bench.filter((p) => p.p === "GK");
            const out = bench.filter((p) => p.p !== "GK");
            return [
              ...gk.map((p) => ({ p, label: "GK", cls: "is-gk" })),
              ...out.map((p, k) => ({ p, label: `${k + 1}.`, cls: "" })),
            ].map(({ p, label, cls }) => (
              <div key={p.i} className={`bench-slot ${cls}`}>
                <Shirt p={p} gi={gi} small {...shirtProps(p)} />
                <span className="slot-n">{label}</span>
              </div>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
