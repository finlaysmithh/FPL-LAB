import React, { useState, useMemo, useCallback, useEffect } from "react";

const DATA = __DATA__;
const OPTIMAL = __OPTIMAL__;

const QUOTA = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const XI_MIN = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const XI_MAX = { GK: 1, DEF: 5, MID: 5, FWD: 3 };
const BUDGET = 100.0;
const POS_ORDER = ["GK", "DEF", "MID", "FWD"];
const SEED = OPTIMAL.range.squad;

const byId = {};
DATA.players.forEach((p) => (byId[p.i] = p));

// Real club kit identities: base, secondary, and pattern.
// pattern: solid | stripes | halves | sash | hoops
const KITS = {
  ARS: { b: "#EF0107", s: "#FFFFFF", p: "sleeves", n: "#FFFFFF" },
  AVL: { b: "#95BFE5", s: "#670E36", p: "claretbody", n: "#FFFFFF" },
  BOU: { b: "#DA291C", s: "#000000", p: "stripes", n: "#FFFFFF" },
  BRE: { b: "#E30613", s: "#FFFFFF", p: "stripes", n: "#FFFFFF" },
  BHA: { b: "#0057B8", s: "#FFFFFF", p: "stripes", n: "#FFFFFF" },
  CHE: { b: "#034694", s: "#FFFFFF", p: "solid", n: "#FFFFFF" },
  COV: { b: "#7DD3F0", s: "#001C58", p: "solid", n: "#001C58" },
  CRY: { b: "#1B458F", s: "#C4122E", p: "stripes", n: "#FFFFFF" },
  EVE: { b: "#003399", s: "#FFFFFF", p: "solid", n: "#FFFFFF" },
  FUL: { b: "#FFFFFF", s: "#000000", p: "solid", n: "#000000" },
  HUL: { b: "#F5971D", s: "#000000", p: "stripes", n: "#000000" },
  IPS: { b: "#3A64A3", s: "#FFFFFF", p: "solid", n: "#FFFFFF" },
  LEE: { b: "#FFFFFF", s: "#1D428A", p: "solid", n: "#1D428A" },
  LIV: { b: "#C8102E", s: "#00B2A9", p: "solid", n: "#FFFFFF" },
  MCI: { b: "#6CABDD", s: "#1C2C5B", p: "solid", n: "#FFFFFF" },
  MUN: { b: "#DA291C", s: "#000000", p: "solid", n: "#FFFFFF" },
  NEW: { b: "#241F20", s: "#FFFFFF", p: "stripes", n: "#FFFFFF" },
  NFO: { b: "#DD0000", s: "#FFFFFF", p: "solid", n: "#FFFFFF" },
  SUN: { b: "#EB172B", s: "#FFFFFF", p: "stripes", n: "#FFFFFF" },
  TOT: { b: "#FFFFFF", s: "#132257", p: "solid", n: "#132257" },
};

function Jersey({ team, size = 34 }) {
  const k = KITS[team] || { b: "#64748b", s: "#e2e8f0", p: "solid" };
  const id = `k${team}`;
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
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
      </g>
      {/* collar */}
      <path d="M13 5 L22 9 L31 5 L28.5 11 L22 13.5 L15.5 11 Z"
        fill={k.s} opacity="0.9" />
      <path d="M13 5 L22 9 L31 5 L42 12 L37.5 20 L34 18 V40 H10 V18 L6.5 20 L2 12 Z"
        fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function fdrColor(v) {
  if (v == null) return "#334155";
  if (v <= 3) return "#34d399";
  if (v <= 4.5) return "#a3e635";
  if (v <= 6) return "#fcd34d";
  if (v <= 7.5) return "#fb923c";
  return "#f43f5e";
}
const money = (v) => "£" + v.toFixed(1) + "m";

// ---- squad logic ---------------------------------------------------------
const posCounts = (ids) => {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  ids.forEach((i) => byId[i] && c[byId[i].p]++);
  return c;
};
const clubCounts = (ids) => {
  const c = {};
  ids.forEach((i) => byId[i] && (c[byId[i].t] = (c[byId[i].t] || 0) + 1));
  return c;
};
const squadCost = (ids) => ids.reduce((s, i) => s + (byId[i]?.c || 0), 0);

function validate(ids) {
  const errs = [];
  const pc = posCounts(ids);
  POS_ORDER.forEach((p) => pc[p] !== QUOTA[p] && errs.push(`${pc[p]}/${QUOTA[p]} ${p}`));
  Object.entries(clubCounts(ids)).forEach(([t, n]) => n > 3 && errs.push(`${n} from ${t} (max 3)`));
  if (squadCost(ids) > BUDGET + 1e-6) errs.push(`${money(squadCost(ids))} over budget`);
  return errs;
}

function bestXI(ids, gi) {
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
  const capt = [...xi].sort((a, b) => b.g[gi] - a.g[gi])[0];
  const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const bench = pool.filter((p) => !xi.includes(p))
    .sort((a, b) => (a.p === "GK" ? 1 : b.p === "GK" ? -1 : b.g[gi] - a.g[gi]));
  return { xi, bench, capt, cnt };
}
// Scoring rules: ONLY the starting XI counts, plus the captain again (double
// points). The bench scores NOTHING unless Bench Boost is played — bench value
// matters only as insurance against a non-starter, and for that one chip.
const gwScore = (ids, gi) => {
  const { xi, capt } = bestXI(ids, gi);
  return xi.reduce((s, p) => s + p.g[gi], 0) + (capt ? capt.g[gi] : 0);
};
const benchScore = (ids, gi) => bestXI(ids, gi).bench.reduce((s, p) => s + p.g[gi], 0);
const xiOnly = (ids, gi) => bestXI(ids, gi).xi.reduce((s, p) => s + p.g[gi], 0);

// ---- FPL-style shirt card ------------------------------------------------
function Shirt({ p, gi, isCapt, isVice, onClick, small }) {
  const k = KITS[p.t] || {};
  const w = small ? 56 : 64;
  return (
    <button onClick={onClick} style={{ width: w }}
      className="relative flex flex-col items-center active:scale-95 transition group">
      {isCapt && (
        <span className="absolute top-0 right-0 z-20 bg-white text-slate-900 text-[9px] font-black w-[16px] h-[16px] rounded-full flex items-center justify-center shadow ring-1 ring-slate-900/40">C</span>
      )}
      {isVice && (
        <span className="absolute top-0 right-0 z-20 bg-slate-900 text-white text-[8px] font-black w-[16px] h-[16px] rounded-full flex items-center justify-center ring-1 ring-white/50">V</span>
      )}
      {p.pk === 1 && (
        <span title="Penalty taker"
          className="absolute top-0 left-0 z-20 bg-emerald-400 text-slate-900 text-[8px] font-black w-[16px] h-[16px] rounded-full flex items-center justify-center shadow">P</span>
      )}
      <Jersey team={p.t} size={small ? 30 : 36} />
      <div className="w-full -mt-1 rounded-md overflow-hidden shadow-md ring-1 ring-black/30">
        <div className="px-1 py-[2px] text-[9px] font-semibold text-white truncate text-center leading-[11px]"
          style={{ background: "rgba(15,23,42,.92)" }}>
          {p.n}
        </div>
        <div className="px-1 flex items-center justify-center gap-1 leading-[13px]"
          style={{ background: "rgba(2,6,23,.92)" }}>
          <span className="text-[10px] font-black text-white font-mono tabular-nums">
            {p.g[gi].toFixed(1)}
          </span>
          <span className="text-[8px] text-slate-400 font-mono">{p.c.toFixed(1)}</span>
        </div>
      </div>
      <div className="flex gap-[1.5px] mt-[3px]">
        {DATA.fdr[p.t]?.a.map((v, j) => (
          <div key={j} className="rounded-[1px]"
            style={{ width: 6, height: 4, background: fdrColor(v),
                     opacity: j === gi ? 1 : 0.4,
                     boxShadow: j === gi ? "0 0 0 1px rgba(251,191,36,.9)" : "none" }} />
        ))}
      </div>
    </button>
  );
}

// ---- the pitch -----------------------------------------------------------
function CaptainBar({ ids, gi }) {
  const { xi, capt } = bestXI(ids, gi);
  const vice = [...xi].filter((p) => p !== capt).sort((a, b) => b.g[gi] - a.g[gi])[0];
  if (!capt) return null;
  const edge = vice ? capt.g[gi] - vice.g[gi] : 0;
  return (
    <div className="bg-slate-900 rounded-lg px-3 py-2 mb-2 border border-amber-400/30">
      <div className="flex items-center gap-2">
        <span className="bg-amber-400 text-slate-950 text-[11px] font-black w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0">C</span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-bold text-white truncate">
            Captain {capt.n} <span className="text-slate-400 font-normal">({capt.t})</span>
          </div>
          <div className="text-[10px] text-slate-400">
            {capt.g[gi].toFixed(1)} × 2 = <span className="text-amber-300 font-bold">{(capt.g[gi] * 2).toFixed(1)} pts</span>
            {vice && ` · ${edge < 0.3 ? "close call over" : "clear of"} ${vice.n} (V)`}
          </div>
        </div>
      </div>
    </div>
  );
}

function Pitch({ ids, gi, onTap, readOnly }) {
  const { xi, bench, capt } = bestXI(ids, gi);
  const vice = [...xi].filter((p) => p !== capt).sort((a, b) => b.g[gi] - a.g[gi])[0];
  const rows = POS_ORDER.map((pos) => xi.filter((p) => p.p === pos));

  return (
    <div>
      <div className="relative rounded-xl overflow-hidden ring-1 ring-emerald-950" style={{
        background: "linear-gradient(#1f8a46 0%,#17803f 45%,#116434 100%)",
      }}>
        {/* mown stripes */}
        <div className="absolute inset-0 opacity-[0.10]" style={{
          backgroundImage: "repeating-linear-gradient(#fff 0 38px, transparent 38px 76px)",
        }} />
        {/* floodlight falloff */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: "radial-gradient(120% 70% at 50% 8%, rgba(255,255,255,.16), rgba(0,0,0,0) 55%), linear-gradient(rgba(0,0,0,0) 60%, rgba(0,0,0,.28))",
        }} />

        <div className="relative py-3 px-1">
          {rows.map((row, ri) => (
            <div key={ri} className="flex justify-center gap-1 mb-2.5 flex-wrap">
              {row.map((p) => (
                <Shirt key={p.i} p={p} gi={gi}
                  isCapt={capt && p.i === capt.i}
                  isVice={vice && p.i === vice.i}
                  onClick={() => !readOnly && onTap && onTap(p)} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* bench, FPL style */}
      <div className="mt-1.5 rounded-lg bg-slate-800/80 border border-white/10 px-1 py-2">
        <div className="text-center mb-1.5">
          <div className="text-[9px] text-slate-400 uppercase tracking-widest">
            Substitutes
          </div>
          <div className="text-[9px] text-slate-500">
            scores 0 unless Bench Boost — {benchScore(ids, gi).toFixed(1)} pts sitting there
          </div>
        </div>
        <div className="flex justify-center gap-1">
          {bench.map((p, k) => (
            <div key={p.i} className="flex flex-col items-center">
              <Shirt p={p} gi={gi} small onClick={() => !readOnly && onTap && onTap(p)} />
              <span className="text-[8px] text-slate-500 mt-0.5">
                {p.p === "GK" ? "GK" : k + 1}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FixtureStrip({ team, gi }) {
  const f = DATA.fdr[team];
  if (!f) return null;
  return (
    <div className="flex gap-0.5">
      {f.a.map((v, k) => (
        <div key={k} className="w-6 h-4 rounded-sm flex items-center justify-center text-[8px] font-bold"
          style={{ background: fdrColor(v), color: v > 6 ? "#fff" : "#0f172a",
                   outline: k === gi ? "1.5px solid #fbbf24" : "none" }}>
          {f.o[k].slice(0, 3)}
        </div>
      ))}
    </div>
  );
}

// ---- swap sheet ----------------------------------------------------------
function SwapSheet({ open, pos, current, squad, gi, onPick, onClose }) {
  const [sort, setSort] = useState("x");
  const [q, setQ] = useState("");
  const [maxC, setMaxC] = useState(null);
  if (!open) return null;

  const others = squad.filter((i) => i !== current);
  const left = BUDGET - squadCost(others);
  const cc = clubCounts(others);

  let list = DATA.players.filter((p) => p.p === pos && !others.includes(p.i));
  if (maxC) list = list.filter((p) => p.c <= maxC);
  if (q.trim()) list = list.filter((p) =>
    p.n.toLowerCase().includes(q.toLowerCase()) || p.t.toLowerCase().includes(q.toLowerCase()));
  list = [...list].sort((a, b) =>
    sort === "x" ? b.x - a.x : sort === "gw" ? b.g[gi] - a.g[gi] :
    sort === "c" ? a.c - b.c : sort === "v" ? b.x / b.c - a.x / a.c : a.o - b.o);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75">
      <div className="w-full sm:max-w-lg max-h-[86vh] bg-slate-900 rounded-t-2xl sm:rounded-2xl border-t sm:border border-emerald-400/25 flex flex-col">
        <div className="p-3 border-b border-white/10">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-white font-bold text-sm">Pick a {pos}</h3>
            <button onClick={onClose} className="text-slate-400 text-xs px-2 py-1">Close</button>
          </div>
          <div className="text-[11px] text-slate-400 mb-2">{money(left)} available for this slot</div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search player or team"
            className="w-full bg-slate-800 text-white text-xs rounded px-2 py-1.5 mb-2 outline-none focus:ring-1 focus:ring-emerald-400" />
          <div className="flex gap-1 flex-wrap">
            {[["x", "Total xP"], ["gw", `GW${DATA.gws[gi]}`], ["v", "Pts per £m"], ["c", "Cheapest"], ["o", "Differential"]]
              .map(([k, label]) => (
              <button key={k} onClick={() => setSort(k)}
                className={`text-[10px] px-2 py-1 rounded ${sort === k ? "bg-emerald-400 text-slate-950 font-bold" : "bg-slate-800 text-slate-300"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 mt-1.5 items-center">
            <span className="text-[9px] text-slate-500 uppercase mr-0.5">Max</span>
            {[null, 4.5, 5.0, 5.5, 6.5, 8.0].map((v, k) => (
              <button key={k} onClick={() => setMaxC(v)}
                className={`text-[10px] px-2 py-1 rounded font-mono ${maxC === v ? "bg-amber-400 text-slate-950 font-bold" : "bg-slate-800 text-slate-300"}`}>
                {v ? v.toFixed(1) : "Any"}
              </button>
            ))}
          </div>
          <div className="text-[9px] text-slate-500 mt-1.5">{list.length} shown</div>
        </div>
        <div className="overflow-y-auto flex-1">
          {list.map((p) => {
            const afford = p.c <= left + 1e-6;
            const clubOk = (cc[p.t] || 0) < 3;
            const ok = afford && clubOk;
            return (
              <button key={p.i} disabled={!ok} onClick={() => onPick(p.i)}
                className={`w-full flex items-center gap-2 px-3 py-2 border-b border-white/5 text-left ${ok ? "hover:bg-slate-800" : "opacity-35"} ${p.i === current ? "bg-emerald-400/10" : ""}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-white font-medium truncate">
                    {p.n}{p.pk === 1 && <span className="ml-1 text-emerald-300 text-[9px]">PEN</span>}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {p.t} · {money(p.c)} · {p.o}%
                    {!afford && " · too expensive"}{afford && !clubOk && ` · 3 ${p.t} already`}
                  </div>
                </div>
                <FixtureStrip team={p.t} gi={gi} />
                <div className="text-right w-14">
                  <div className="text-[13px] font-black text-white font-mono">{p.x.toFixed(1)}</div>
                  <div className="text-[9px] text-emerald-400 font-mono">{(p.x / p.c).toFixed(1)}/£m</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- transfer engine -----------------------------------------------------
function bestTransfers(squad, horizon, limit = 8) {
  const ideas = [];
  const base = horizon.reduce((s, k) => s + gwScore(squad, k), 0);
  for (const outId of squad) {
    const o = byId[outId];
    if (!o) continue;
    const others = squad.filter((x) => x !== outId);
    const left = BUDGET - squadCost(others);
    const cc = clubCounts(others);
    const cands = DATA.players.filter((p) =>
      p.p === o.p && !others.includes(p.i) && p.c <= left + 1e-6 && (cc[p.t] || 0) < 3);
    for (const c of cands) {
      const next = others.concat([c.i]);
      const gain = horizon.reduce((s, k) => s + gwScore(next, k), 0) - base;
      if (gain > 0.05) ideas.push({ out: o, in: c, gain });
    }
  }
  return ideas.sort((a, b) => b.gain - a.gain).slice(0, limit);
}

function grade(pct) {
  if (pct >= 97) return { g: "A+", c: "#34d399", t: "Elite — at or near the optimum" };
  if (pct >= 93) return { g: "A", c: "#4ade80", t: "Very strong squad" };
  if (pct >= 88) return { g: "B", c: "#a3e635", t: "Solid, a few upgrades available" };
  if (pct >= 82) return { g: "C", c: "#fcd34d", t: "Mid — real points being left behind" };
  if (pct >= 75) return { g: "D", c: "#fb923c", t: "Weak — consider a wildcard" };
  return { g: "E", c: "#f43f5e", t: "Well off the pace — wildcard territory" };
}

// ==========================================================================
export default function App() {
  const [tab, setTab] = useState("optimal");
  const [gi, setGi] = useState(0);
  const [squad, setSquad] = useState(SEED);
  const [mySquad, setMySquad] = useState(null);
  const [swap, setSwap] = useState(null);
  const [mySwap, setMySwap] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("my_squad");
        if (r?.value) setMySquad(JSON.parse(r.value));
      } catch (e) { /* nothing saved yet */ }
      setLoaded(true);
    })();
  }, []);

  const saveMine = useCallback(async (ids) => {
    setMySquad(ids);
    try { await window.storage.set("my_squad", JSON.stringify(ids)); } catch (e) {}
  }, []);

  const perGw = useMemo(() => DATA.gws.map((_, k) => gwScore(squad, k)), [squad]);
  const total = perGw.reduce((a, b) => a + b, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-white pb-16">
      <div className="sticky top-0 z-30 bg-slate-950/97 backdrop-blur border-b border-white/10">
        <div className="px-3 pt-2.5 pb-2 flex items-baseline justify-between">
          <h1 className="text-sm font-black tracking-[0.22em] text-emerald-400">FPL LAB</h1>
          <span className="text-[9px] text-slate-500 font-mono">
            {DATA.players.length} players · real data
          </span>
        </div>
        <div className="flex border-t border-white/10 overflow-x-auto">
          {[["optimal", "Optimal XI"], ["myteam", "My Team"], ["builder", "Builder"],
            ["value", "Value"], ["fixtures", "Fixtures"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-shrink-0 px-3 py-2 text-[11px] font-bold ${tab === k ? "text-emerald-400 border-b-2 border-emerald-400" : "text-slate-500"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* ============ OPTIMAL XI ============ */}
      {tab === "optimal" && (() => {
        const o = OPTIMAL[String(DATA.gws[gi])];
        return (
          <div className="px-2 pt-3">
            <div className="flex gap-1 overflow-x-auto mb-2 px-1">
              {DATA.gws.map((g, k) => (
                <button key={g} onClick={() => setGi(k)}
                  className={`flex-shrink-0 px-3 py-1.5 rounded text-[11px] font-bold font-mono ${k === gi ? "bg-emerald-400 text-slate-950" : "bg-slate-900 text-slate-400"}`}>
                  GW{g}
                  <span className="ml-1 opacity-70">{OPTIMAL[String(g)].xp}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 mb-2 px-1">
              <div className="bg-slate-900 rounded-lg px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Projected</div>
                <div className="text-sm font-black font-mono text-amber-300">{o.xp} pts</div>
              </div>
              <div className="bg-slate-900 rounded-lg px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Cost</div>
                <div className="text-sm font-black font-mono">{money(o.cost)}</div>
              </div>
              <div className="bg-slate-900 rounded-lg px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Bank</div>
                <div className="text-sm font-black font-mono text-emerald-400">{money(BUDGET - o.cost)}</div>
              </div>
            </div>
            <div className="px-0">
              <CaptainBar ids={o.squad} gi={gi} />
            </div>
            <Pitch ids={o.squad} gi={gi} readOnly />
            <div className="mt-2 bg-slate-900 rounded-lg px-3 py-2 text-[10px] text-slate-400">
              <div className="flex justify-between"><span>Starting XI</span>
                <span className="font-mono text-white">{xiOnly(o.squad, gi).toFixed(1)}</span></div>
              <div className="flex justify-between"><span>Captain doubled</span>
                <span className="font-mono text-amber-300">+{(bestXI(o.squad, gi).capt?.g[gi] || 0).toFixed(1)}</span></div>
              <div className="flex justify-between text-slate-600"><span>Bench (not counted)</span>
                <span className="font-mono">{benchScore(o.squad, gi).toFixed(1)}</span></div>
              <div className="flex justify-between border-t border-white/10 mt-1 pt-1 text-white font-bold">
                <span>GW{DATA.gws[gi]} total</span><span className="font-mono text-amber-300">{o.xp}</span></div>
            </div>
            <p className="mt-2 px-1 text-[10px] text-slate-500 leading-relaxed">
              The highest-scoring legal squad for GW{DATA.gws[gi]} alone, solved
              under the full £100m budget, 2/5/5/3 quota and 3-per-club limit.
              Captain doubles. Each week is solved independently, so the squads
              differ — that's the cost of chasing one week at a time.
            </p>
            <button onClick={() => { setSquad(o.squad); setTab("builder"); }}
              className="w-full mt-2 bg-emerald-400 text-slate-950 text-[11px] font-black py-2.5 rounded-lg">
              Open this squad in the Builder
            </button>
          </div>
        );
      })()}

      {/* ============ MY TEAM ============ */}
      {tab === "myteam" && (
        <div className="px-2 pt-3">
          {!loaded ? (
            <div className="text-slate-500 text-xs px-1">Loading…</div>
          ) : !mySquad ? (
            <div className="px-1">
              <h2 className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
                Import your team
              </h2>
              <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                Start from a squad below, then tap any player to swap him for who
                you actually own. Your team is saved on this device, so it's here
                next time.
              </p>
              <button onClick={() => saveMine(OPTIMAL.range.squad)}
                className="w-full bg-emerald-400 text-slate-950 text-[11px] font-black py-2.5 rounded-lg mb-2">
                Start from the optimal squad
              </button>
              <button onClick={() => saveMine(OPTIMAL["1"].squad)}
                className="w-full bg-slate-800 text-white text-[11px] font-bold py-2.5 rounded-lg mb-2">
                Start from the GW1 optimal squad
              </button>
              <button onClick={() => {
                  const cheap = {};
                  POS_ORDER.forEach((pos) => {
                    cheap[pos] = DATA.players.filter((p) => p.p === pos)
                      .sort((a, b) => a.c - b.c);
                  });
                  const ids = []; const cc = {};
                  POS_ORDER.forEach((pos) => {
                    let n = 0;
                    for (const p of cheap[pos]) {
                      if (n >= QUOTA[pos]) break;
                      if ((cc[p.t] || 0) >= 3) continue;
                      ids.push(p.i); cc[p.t] = (cc[p.t] || 0) + 1; n++;
                    }
                  });
                  saveMine(ids);
                }}
                className="w-full bg-slate-800 text-white text-[11px] font-bold py-2.5 rounded-lg">
                Start from a blank £-minimum squad
              </button>
            </div>
          ) : (() => {
            const myPer = DATA.gws.map((_, k) => gwScore(mySquad, k));
            const myTotal = myPer.reduce((a, b) => a + b, 0);
            const optTotal = OPTIMAL.range.xp;
            const pct = (myTotal / optTotal) * 100;
            const gr = grade(pct);
            const errs = validate(mySquad);
            const nextIdeas = bestTransfers(mySquad, [gi], 5);
            const rangeIdeas = bestTransfers(mySquad, DATA.gws.map((_, k) => k), 5);
            return (
              <div>
                <div className="flex gap-1 overflow-x-auto mb-2 px-1">
                  {DATA.gws.map((g, k) => (
                    <button key={g} onClick={() => setGi(k)}
                      className={`flex-shrink-0 px-3 py-1.5 rounded text-[11px] font-bold font-mono ${k === gi ? "bg-emerald-400 text-slate-950" : "bg-slate-900 text-slate-400"}`}>
                      GW{g}<span className="ml-1 opacity-70">{myPer[k].toFixed(0)}</span>
                    </button>
                  ))}
                </div>

                {/* score card */}
                <div className="bg-slate-900 rounded-lg p-3 mb-2 flex items-center gap-3">
                  <div className="w-14 h-14 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: gr.c + "22", border: `2px solid ${gr.c}` }}>
                    <span className="text-2xl font-black" style={{ color: gr.c }}>{gr.g}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-white">{myTotal.toFixed(1)} pts projected</div>
                    <div className="text-[10px] text-slate-400">
                      {pct.toFixed(1)}% of the optimal {optTotal} · {gr.t}
                    </div>
                    <div className="mt-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: gr.c }} />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-2 px-0">
                  <div className="bg-slate-900 rounded-lg px-2 py-1.5">
                    <div className="text-[9px] text-slate-500 uppercase">Value</div>
                    <div className={`text-sm font-black font-mono ${squadCost(mySquad) > BUDGET ? "text-rose-400" : ""}`}>
                      {money(squadCost(mySquad))}
                    </div>
                  </div>
                  <div className="bg-slate-900 rounded-lg px-2 py-1.5">
                    <div className="text-[9px] text-slate-500 uppercase">Bank</div>
                    <div className="text-sm font-black font-mono text-emerald-400">{money(BUDGET - squadCost(mySquad))}</div>
                  </div>
                  <div className="bg-slate-900 rounded-lg px-2 py-1.5">
                    <div className="text-[9px] text-slate-500 uppercase">Gap</div>
                    <div className="text-sm font-black font-mono text-amber-300">
                      {(optTotal - myTotal).toFixed(1)}
                    </div>
                  </div>
                </div>

                {errs.length > 0 && (
                  <div className="text-[10px] text-rose-300 bg-rose-950/50 rounded px-2 py-1 mb-2">
                    {errs.join(" · ")}
                  </div>
                )}

                <CaptainBar ids={mySquad} gi={gi} />
                <Pitch ids={mySquad} gi={gi} onTap={(p) => setMySwap({ current: p.i, pos: p.p })} />
                <div className="mt-2 bg-slate-900 rounded-lg px-3 py-2 text-[10px] text-slate-400">
                  <div className="flex justify-between"><span>Starting XI</span>
                    <span className="font-mono text-white">{xiOnly(mySquad, gi).toFixed(1)}</span></div>
                  <div className="flex justify-between"><span>Captain doubled</span>
                    <span className="font-mono text-amber-300">+{(bestXI(mySquad, gi).capt?.g[gi] || 0).toFixed(1)}</span></div>
                  <div className="flex justify-between text-slate-600"><span>Bench (not counted)</span>
                    <span className="font-mono">{benchScore(mySquad, gi).toFixed(1)}</span></div>
                  <div className="flex justify-between border-t border-white/10 mt-1 pt-1 text-white font-bold">
                    <span>GW{DATA.gws[gi]} total</span>
                    <span className="font-mono text-amber-300">{myPer[gi].toFixed(1)}</span></div>
                </div>

                {/* transfer suggestions */}
                <div className="mt-3 px-1">
                  <h3 className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider mb-1">
                    Best transfers for GW{DATA.gws[gi]}
                  </h3>
                  {nextIdeas.length === 0 && (
                    <div className="text-[11px] text-slate-400 bg-slate-900 rounded-lg p-3 mb-2">
                      Nothing improves this squad for GW{DATA.gws[gi]}. Bank the transfer.
                    </div>
                  )}
                  {nextIdeas.map((t, k) => (
                    <button key={k} onClick={() => saveMine(mySquad.map((x) => (x === t.out.i ? t.in.i : x)))}
                      className="w-full bg-slate-900 rounded-lg p-2.5 mb-1.5 text-left border border-white/5 active:bg-slate-800">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-rose-300 truncate">− {t.out.n} ({t.out.t} {money(t.out.c)})</div>
                          <div className="text-[11px] text-emerald-300 truncate">+ {t.in.n} ({t.in.t} {money(t.in.c)})</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-black text-amber-300 font-mono">+{t.gain.toFixed(1)}</div>
                          <div className="text-[8px] text-slate-500">this GW</div>
                        </div>
                      </div>
                    </button>
                  ))}

                  <h3 className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider mb-1 mt-3">
                    Best transfers across all {DATA.gws.length} gameweeks
                  </h3>
                  {rangeIdeas.map((t, k) => (
                    <button key={k} onClick={() => saveMine(mySquad.map((x) => (x === t.out.i ? t.in.i : x)))}
                      className="w-full bg-slate-900 rounded-lg p-2.5 mb-1.5 text-left border border-white/5 active:bg-slate-800">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-rose-300 truncate">− {t.out.n} ({t.out.t})</div>
                          <div className="text-[11px] text-emerald-300 truncate">+ {t.in.n} ({t.in.t} {money(t.in.c)})</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-black text-amber-300 font-mono">+{t.gain.toFixed(1)}</div>
                          <div className="text-[8px] text-slate-500">6 GW</div>
                        </div>
                      </div>
                      <div className="mt-1 flex justify-end"><FixtureStrip team={t.in.t} gi={gi} /></div>
                    </button>
                  ))}
                  <p className="text-[10px] text-slate-500 mt-1 mb-2">
                    Under +4.0 isn't worth a −4 hit. A transfer that helps one week
                    but not the range is usually worth rolling instead.
                  </p>
                  <button onClick={() => saveMine(null)}
                    className="w-full bg-slate-800 text-slate-300 text-[11px] font-bold py-2 rounded-lg">
                    Clear my team
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ============ BUILDER ============ */}
      {tab === "builder" && (
        <div className="px-2 pt-3">
          <div className="flex gap-1 overflow-x-auto mb-2 px-1">
            {DATA.gws.map((g, k) => (
              <button key={g} onClick={() => setGi(k)}
                className={`flex-shrink-0 px-3 py-1.5 rounded text-[11px] font-bold font-mono ${k === gi ? "bg-emerald-400 text-slate-950" : "bg-slate-900 text-slate-400"}`}>
                GW{g}<span className="ml-1 opacity-70">{perGw[k].toFixed(0)}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 mb-2 px-1">
            <div className="bg-slate-900 rounded-lg px-2 py-1.5">
              <div className="text-[9px] text-slate-500 uppercase">Value</div>
              <div className={`text-sm font-black font-mono ${squadCost(squad) > BUDGET ? "text-rose-400" : ""}`}>{money(squadCost(squad))}</div>
            </div>
            <div className="bg-slate-900 rounded-lg px-2 py-1.5">
              <div className="text-[9px] text-slate-500 uppercase">Bank</div>
              <div className="text-sm font-black font-mono text-emerald-400">{money(BUDGET - squadCost(squad))}</div>
            </div>
            <div className="bg-slate-900 rounded-lg px-2 py-1.5">
              <div className="text-[9px] text-slate-500 uppercase">6-GW total</div>
              <div className="text-sm font-black font-mono text-amber-300">{total.toFixed(1)}</div>
            </div>
          </div>
          {validate(squad).length > 0 && (
            <div className="text-[10px] text-rose-300 bg-rose-950/50 rounded px-2 py-1 mb-2 mx-1">
              {validate(squad).join(" · ")}
            </div>
          )}
          <CaptainBar ids={squad} gi={gi} />
          <Pitch ids={squad} gi={gi} onTap={(p) => setSwap({ current: p.i, pos: p.p })} />
          <div className="mt-2 bg-slate-900 rounded-lg px-3 py-2 text-[10px] text-slate-400">
            <div className="flex justify-between"><span>Starting XI</span>
              <span className="font-mono text-white">{xiOnly(squad, gi).toFixed(1)}</span></div>
            <div className="flex justify-between"><span>Captain doubled</span>
              <span className="font-mono text-amber-300">+{(bestXI(squad, gi).capt?.g[gi] || 0).toFixed(1)}</span></div>
            <div className="flex justify-between text-slate-600"><span>Bench (not counted)</span>
              <span className="font-mono">{benchScore(squad, gi).toFixed(1)}</span></div>
            <div className="flex justify-between border-t border-white/10 mt-1 pt-1 text-white font-bold">
              <span>GW{DATA.gws[gi]} total</span>
              <span className="font-mono text-amber-300">{perGw[gi].toFixed(1)}</span></div>
          </div>

          <div className="mt-2 px-1 grid grid-cols-2 gap-2">
            <button onClick={() => setSquad(OPTIMAL.range.squad)}
              className="bg-emerald-400 text-slate-950 text-[11px] font-black py-2 rounded-lg">
              Reset to optimal
            </button>
            <button onClick={() => saveMine(squad)}
              className="bg-slate-800 text-white text-[11px] font-bold py-2 rounded-lg">
              Save as my team
            </button>
          </div>

          {/* chips advice */}
          <div className="mt-3 px-1">
            <div className="bg-slate-900 rounded-lg p-3 mb-2">
              <div className="text-[10px] text-slate-500 uppercase mb-2">Projected points by gameweek</div>
              <div className="flex items-end gap-1 h-20">
                {perGw.map((v, k) => (
                  <div key={k} className="flex-1 flex flex-col items-center">
                    <div className="text-[9px] font-mono text-slate-400">{v.toFixed(0)}</div>
                    <div className={`w-full rounded-t ${v === Math.min(...perGw) ? "bg-rose-500" : v === Math.max(...perGw) ? "bg-emerald-400" : "bg-teal-700"}`}
                      style={{ height: `${(v / Math.max(...perGw)) * 100}%` }} />
                    <div className="text-[9px] text-slate-500 mt-0.5">{DATA.gws[k]}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-900 rounded-lg p-3 mb-2">
              <div className="text-[10px] text-slate-500 uppercase mb-1.5">Captain each week</div>
              {DATA.gws.map((g, k) => {
                const c = bestXI(squad, k).capt;
                if (!c) return null;
                const best = Math.max(...DATA.gws.map((_, j) => bestXI(squad, j).capt?.g[j] || 0));
                return (
                  <div key={g} className="flex items-center justify-between py-0.5">
                    <span className="text-[10px] font-mono text-slate-500 w-9">GW{g}</span>
                    <span className="text-[11px] text-white flex-1 truncate">{c.n}
                      <span className="text-slate-500 ml-1">{c.t}</span></span>
                    <span className={`text-[11px] font-mono font-bold ${c.g[k] === best ? "text-amber-300" : "text-slate-400"}`}>
                      {(c.g[k] * 2).toFixed(1)}
                    </span>
                  </div>
                );
              })}
              <div className="text-[9px] text-slate-500 mt-1.5">
                Points shown are already doubled. Amber is your best Triple Captain window.
              </div>
            </div>
            {(() => {
              const avg = total / perGw.length;
              const worst = perGw.indexOf(Math.min(...perGw));
              const bb = DATA.gws.map((_, k) => bestXI(squad, k).bench.reduce((s, p) => s + p.g[k], 0));
              const bbBest = bb.indexOf(Math.max(...bb));
              const caps = DATA.gws.map((_, k) => { const c = bestXI(squad, k).capt; return { gw: DATA.gws[k], p: c, v: c ? c.g[k] : 0 }; });
              const tc = [...caps].sort((a, b) => b.v - a.v)[0];
              const items = [];
              if (perGw[worst] < avg * 0.9)
                items.push(["Wildcard", DATA.gws[worst], "warn",
                  `GW${DATA.gws[worst]} projects ${perGw[worst].toFixed(1)}, ${(((avg - perGw[worst]) / avg) * 100).toFixed(0)}% under your average. Fixtures turn — a wildcard here resets you into the good runs.`]);
              items.push(["Bench Boost", bb[bbBest] > 12 ? DATA.gws[bbBest] : null, bb[bbBest] > 12 ? "good" : "muted",
                bb[bbBest] > 12 ? `Your bench scores nothing in a normal week. In GW${DATA.gws[bbBest]} it projects ${bb[bbBest].toFixed(1)} — the best of the range, so that is the week Bench Boost actually pays.`
                  : `Best bench week is only ${bb[bbBest].toFixed(1)}, and the bench scores nothing without the chip. Hold — you want 16+ before using it.`]);
              items.push(["Triple Captain", tc.gw, tc.v > 6 ? "good" : "muted",
                `${tc.p?.n} in GW${tc.gw} at ${tc.v.toFixed(1)} xP${tc.v > 6 ? " — strong enough to triple." : ". Below the 6.0 bar; hold."}`]);
              return items.map(([chip, gw, tone, text], k) => (
                <div key={k} className={`rounded-lg p-3 mb-2 border ${tone === "good" ? "bg-emerald-950/40 border-emerald-500/30" : tone === "warn" ? "bg-amber-950/40 border-amber-500/30" : "bg-slate-900 border-white/5"}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-bold text-white">{chip}</span>
                    {gw && <span className="text-[10px] font-mono text-amber-300">GW{gw}</span>}
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">{text}</p>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ============ VALUE ============ */}
      {tab === "value" && (
        <div className="px-3 pt-3">
          <h2 className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
            Best pick at every price
          </h2>
          <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
            £100m is a trade-off, not a ranking — every premium is paid for by an
            enabler elsewhere. Amber prices are real upgrades. Grey prices are
            traps: you pay more and project the same or less.
          </p>
          {POS_ORDER.map((pos) => {
            const all = DATA.players.filter((p) => p.p === pos);
            const prices = [...new Set(all.map((p) => p.c))].sort((a, b) => a - b);
            const bands = prices.map((c) => all.filter((p) => p.c === c).reduce((a, b) => (b.x > a.x ? b : a)));
            const maxX = Math.max(...bands.map((b) => b.x), 1);
            let running = -1;
            return (
              <div key={pos} className="mb-4">
                <div className="text-[11px] font-bold text-white mb-1.5">{pos}</div>
                {bands.map((b) => {
                  const jump = b.x > running;
                  if (jump) running = b.x;
                  return (
                    <div key={b.i} className="flex items-center gap-2 py-[3px]">
                      <span className={`text-[10px] font-mono w-9 ${jump ? "text-amber-300 font-bold" : "text-slate-600"}`}>{b.c.toFixed(1)}</span>
                      <div className="flex-1 h-4 bg-slate-900 rounded-sm overflow-hidden relative">
                        <div className={`h-full ${jump ? "bg-emerald-600" : "bg-slate-700"}`} style={{ width: `${(b.x / maxX) * 100}%` }} />
                        <span className="absolute left-1.5 top-0 text-[9px] leading-4 text-white truncate max-w-[75%]">
                          {b.n}<span className="text-slate-400 ml-1">{b.t}</span>
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-white w-8 text-right">{b.x.toFixed(1)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* ============ FIXTURES ============ */}
      {tab === "fixtures" && (
        <div className="px-2 pt-3">
          <h2 className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1 px-1">Fixture ticker</h2>
          <p className="text-[10px] text-slate-500 mb-3 px-1">
            Attacking difficulty — how hard it is for that team's attackers to score.
            Promoted sides give up the most.
          </p>
          <table className="w-full text-[10px]">
            <thead><tr className="text-slate-500">
              <th className="text-left px-1 py-1">Team</th>
              {DATA.gws.map((g) => <th key={g} className="px-0.5 font-mono">{g}</th>)}
              <th className="px-1">Avg</th>
            </tr></thead>
            <tbody>
              {Object.entries(DATA.fdr).map(([t, f]) => ({ t, f, avg: f.a.reduce((a, b) => a + (b || 5), 0) / f.a.length }))
                .sort((a, b) => a.avg - b.avg).map(({ t, f, avg }) => (
                <tr key={t} className="border-b border-white/5">
                  <td className="px-1 py-1 font-bold text-white">
                    {t}{DATA.promoted.includes(t) && <span className="ml-1 text-[8px] text-emerald-400">NEW</span>}
                  </td>
                  {f.a.map((v, k) => (
                    <td key={k} className="px-0.5 py-1">
                      <div className="rounded text-center py-1 font-bold text-[9px]"
                        style={{ background: fdrColor(v), color: v > 6 ? "#fff" : "#0f172a" }}>{f.o[k]}</div>
                    </td>
                  ))}
                  <td className="px-1 font-mono text-slate-400">{avg.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SwapSheet open={!!swap} pos={swap?.pos} current={swap?.current} squad={squad} gi={gi}
        onPick={(id) => { setSquad((s) => s.map((x) => (x === swap.current ? id : x))); setSwap(null); }}
        onClose={() => setSwap(null)} />
      <SwapSheet open={!!mySwap} pos={mySwap?.pos} current={mySwap?.current} squad={mySquad || []} gi={gi}
        onPick={(id) => { saveMine((mySquad || []).map((x) => (x === mySwap.current ? id : x))); setMySwap(null); }}
        onClose={() => setMySwap(null)} />
    </div>
  );
}
