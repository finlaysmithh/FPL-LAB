import React, { useMemo, useState } from "react";
import {
  DATA, byId, fixtureAt, fdrColor, fdrInk, fdrLabel, money, validate,
} from "./logic.js";
import { managerBriefing, pPlay, security, TOLERANCE } from "./manager.js";
import { Jersey } from "./components.jsx";
import { Pitch } from "./Pitch.jsx";

/**
 * BEST XI — the page that makes the decision instead of showing the numbers.
 *
 * The design rule, and it is the only one that matters here: this should read
 * like a manager who has already thought about it, not like a spreadsheet that
 * has been left open. Every number on the page has to be one a manager would
 * repeat out loud — the opponent, the projection, whether he is fit — and every
 * recommendation has to say why in a sentence, with the arithmetic available
 * underneath for anyone who wants it and hidden from everyone who does not.
 *
 * The engine is `manager.js`. Nothing on this page decides anything itself; if
 * it did, the page and the engine could disagree, and a user cannot tell which
 * of two disagreeing answers is the one the model believes.
 */

const VERDICT = {
  TRANSFER: { c: "#00FF87", ink: "#062a17", word: "TRANSFER", say: "Make the move" },
  HIT: { c: "#FFC72C", ink: "#2a2206", word: "TAKE THE HIT", say: "Worth going early" },
  WAIT: { c: "#04F5FF", ink: "#042a2e", word: "WAIT", say: "Right move, wrong week" },
  ROLL: { c: "#6CC7FF", ink: "#04202e", word: "ROLL", say: "Bank the transfer" },
};

const pct = (v) => `${Math.round(v * 100)}%`;

/** Where a player's points actually come from — the lever, not the total. */
function keyMetric(p) {
  const parts = [
    ["goals", p.cg], ["assists", p.ca], ["clean sheets", p.ccs],
    ["defensive actions", p.cdc], ["bonus", p.cbp], ["saves", p.csv],
  ].filter(([, v]) => v != null && v > 0);
  if (!parts.length) return null;
  parts.sort((a, b) => b[1] - a[1]);
  return { label: parts[0][0], value: parts[0][1] };
}

/** A start probability, said the way a manager would say it. */
const minutesWord = (p) => {
  const q = pPlay(p);
  if (q >= 0.97) return { label: "nailed", tone: "ok" };
  if (q >= 0.88) return { label: "secure", tone: "ok" };
  if (q >= 0.70) return { label: "some risk", tone: "warn" };
  if (q >= 0.45) return { label: "rotation risk", tone: "warn" };
  return { label: "unlikely to start", tone: "bad" };
};

function Fx({ team, gi }) {
  const f = fixtureAt(team, gi);
  if (!f) return <span className="bx-fx blank">BLANK</span>;
  return (
    <span className="bx-fx" style={{ background: fdrColor(f.fdr), color: fdrInk(f.fdr) }}
      title={`${f.home ? "Home to" : "Away at"} ${f.opp} — ${fdrLabel(f.fdr)}`}>
      {f.opp}<i>{f.home ? "H" : "A"}</i>
    </span>
  );
}

/** One row of the team sheet. */
function SheetRow({ p, gi, role }) {
  const m = minutesWord(p);
  const km = keyMetric(p);
  return (
    <div className={`bx-row ${role ? "is-" + role : ""}`}>
      <span className="bx-role">{role === "capt" ? "C" : role === "vice" ? "V" : ""}</span>
      <Jersey team={p.t} size={24} />
      <span className="bx-name">
        {p.n}
        {p.pk === 1 && <i className="bx-pen" title="Penalty taker">P</i>}
      </span>
      <span className="bx-pos">{p.p}</span>
      <Fx team={p.t} gi={gi} />
      <span className="bx-xp" title="Projected points this gameweek">{p.g[gi].toFixed(1)}</span>
      <span className={`bx-mins t-${m.tone}`} title={`${Math.round(pPlay(p) * 100)}% to feature, ${p.ps}% to start`}>
        {Math.round(pPlay(p) * 100)}%<i>{m.label}</i>
      </span>
      <span className="bx-key" title={km ? `${km.value.toFixed(1)} of his projected points over the horizon come from ${km.label}` : ""}>
        {km ? km.label : "—"}
      </span>
    </div>
  );
}

/** A decision, its answer and the one-line reason. */
function Call({ k, v, why, extra }) {
  return (
    <div className="bx-call">
      <div className="bx-call-k">{k}</div>
      <div className="bx-call-v">{v}</div>
      {why && <p className="bx-call-w">{why}</p>}
      {extra}
    </div>
  );
}

export function BestXITab({ gi, setGi, squad, capt, saveCapt, wide }) {
  // Free transfers and spent chips are facts about the user's season that the
  // app cannot read from anywhere, so they are asked for once and remembered.
  const [free, setFree] = useState(() => {
    // `Number(null)` is 0, not NaN — so a missing key has to be caught before
    // the parse, or a first-time visitor is silently told they have no free
    // transfer and every recommendation on the page changes.
    const raw = localStorage.getItem("fpllab:ft");
    if (raw == null) return 1;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 1;
  });
  const [spent, setSpent] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fpllab:chips") || "[]"); } catch { return []; }
  });
  const [showMaths, setShowMaths] = useState(false);

  const setFT = (n) => { setFree(n); try { localStorage.setItem("fpllab:ft", String(n)); } catch {} };
  const toggleChip = (c) => {
    const next = spent.includes(c) ? spent.filter((x) => x !== c) : [...spent, c];
    setSpent(next);
    try { localStorage.setItem("fpllab:chips", JSON.stringify(next)); } catch {}
  };

  const complete = squad.length === 15 && validate(squad).length === 0;
  const brief = useMemo(
    () => (complete ? managerBriefing(squad, gi, { free, captId: capt, span: 6, spent }) : null),
    [squad.join(","), gi, free, capt, spent.join(",")]);

  if (!complete) {
    return (
      <div className="page bx">
        <div className="bx-empty">
          <h2>Pick your fifteen first</h2>
          <p>
            This page decides your eleven, your captain, your bench order and
            your transfer for you. It needs a complete squad to decide from —
            build one on <b>My Squad</b> and come back.
          </p>
        </div>
      </div>
    );
  }
  if (!brief) return <div className="page bx"><div className="bx-empty">Working…</div></div>;

  const s = brief.sheet;
  const t = brief.transfers;
  const v = VERDICT[t.verdict] || VERDICT.ROLL;
  const benchOnly = s.bench;

  return (
    <div className="page bx">
      {/* ---- the week ------------------------------------------------- */}
      <div className="bx-weeks">
        {DATA.gws.slice(0, 12).map((g, k) => (
          <button key={g} className={`bx-week ${k === gi ? "on" : ""}`}
            onClick={() => setGi(k)}>
            {g}
          </button>
        ))}
      </div>

      {/* ---- headline -------------------------------------------------- */}
      <header className="bx-head">
        <div className="bx-head-t">
          <h1>Your optimal team</h1>
          <span className="bx-gw">GW{brief.gw}</span>
        </div>
        <div className="bx-head-n">
          <span className="bx-shape">{s.formation}</span>
          <span className="bx-proj">
            <b>{s.ev.toFixed(1)}</b><i>expected points</i>
          </span>
        </div>
      </header>

      {/* ---- the verdict ----------------------------------------------- */}
      <div className="bx-verdict" style={{ borderColor: v.c + "55" }}>
        <span className="bx-verdict-call" style={{ background: v.c, color: v.ink }}>
          {v.word}
        </span>
        <div className="bx-verdict-body">
          <div className="bx-verdict-head">{t.headline}</div>
          <p className="bx-verdict-say">{brief.summary[0]}</p>
        </div>
        <span className="bx-conf" title="How clearly this beats the next-best option">
          {pct(brief.confidence)}<i>confidence</i>
        </span>
      </div>

      <div className="cols">
      <div className="col-main">

      {/* ---- the team, dominant ---------------------------------------- */}
      <Pitch ids={squad} gi={gi} sheet={s} onTap={undefined} readOnly />

      {/* ---- the five decisions ---------------------------------------- */}
      <section className="bx-sec">
        <h2 className="bx-sec-h">The decisions</h2>
        <div className="bx-calls">
          <Call k="Captain" v={s.capt.n} why={s.captainWhy[0]} />
          <Call k="Vice" v={s.vice.n} why={s.captainWhy[2] || s.captainWhy[1]} />
          <Call k="Formation" v={s.formation} why={s.shapeWhy?.text} />
          <Call k="First sub" v={benchOnly[1]?.n || "—"} why={s.benchWhy[0]} />
        </div>
        {s.tieBreaks.length > 0 && (
          <div className="bx-tie">
            <b>Close calls.</b>
            <ul>{s.tieBreaks.map((x, i) => <li key={i}>{x.why}</li>)}</ul>
          </div>
        )}
      </section>

      {/* ---- the team sheet -------------------------------------------- */}
      <section className="bx-sec">
        <h2 className="bx-sec-h">Team sheet</h2>
        <div className="bx-sheet">
          <div className="bx-row bx-row-h">
            <span /><span /><span>Player</span><span /><span>Opponent</span>
            <span>xPts</span><span>Minutes</span><span>Scores from</span>
          </div>
          {s.xi.map((p) => (
            <SheetRow key={p.i} p={p} gi={gi}
              role={p.i === s.capt.i ? "capt" : p.i === s.vice.i ? "vice" : null} />
          ))}
        </div>
        <div className="bx-benchhead">
          Bench — in order. They score nothing unless someone in your eleven
          plays no minutes at all.
        </div>
        <div className="bx-sheet bx-sheet-bench">
          {benchOnly.map((p, i) => (
            <div key={p.i} className="bx-benchslot">
              <span className="bx-benchno">{i === 0 ? "GK" : i}</span>
              <SheetRow p={p} gi={gi} />
            </div>
          ))}
        </div>
        {s.benchWhy.slice(1).map((w, i) => <p key={i} className="bx-note">{w}</p>)}
      </section>

      {/* ---- transfers -------------------------------------------------- */}
      <section className="bx-sec">
        <h2 className="bx-sec-h">Transfers</h2>
        <div className="bx-ft">
          <span>Free transfers banked</span>
          <div className="bx-ftpick">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={free === n ? "on" : ""} onClick={() => setFT(n)}>{n}</button>
            ))}
          </div>
        </div>

        <div className="bx-why">
          {t.why.map((w, i) => <p key={i}>{w}</p>)}
        </div>

        {t.actNow.length > 0 && (
          <div className="bx-moves">
            <div className="bx-moves-h act">Act now</div>
            <p className="bx-moves-s">Worth doing this week — the value lands in the next two gameweeks.</p>
            {t.actNow.map((m) => <Move key={m.in.i + "-" + m.out.i} m={m} gi={gi} />)}
          </div>
        )}
        {t.planAhead.length > 0 && (
          <div className="bx-moves">
            <div className="bx-moves-h plan">Plan ahead</div>
            <p className="bx-moves-s">
              Real moves whose value sits in weeks you have not reached. A free
              transfer arrives every week, so making these now buys nothing you
              could not buy later.
            </p>
            {t.planAhead.map((m) => <Move key={m.in.i + "-" + m.out.i} m={m} gi={gi} />)}
          </div>
        )}
        {!t.actNow.length && !t.planAhead.length && (
          <p className="bx-note">
            Nothing available meaningfully improves this squad. Swaps worth a
            tenth of a point exist — they always do — but they are inside the
            model's own margin and are not shown as recommendations.
          </p>
        )}
      </section>

      </div>

      <div className="col-side">

      {/* ---- the roadmap ------------------------------------------------ */}
      <section className="bx-sec">
        <h2 className="bx-sec-h">The next six weeks</h2>
        <div className="bx-road">
          {brief.plan.map((r) => (
            <div key={r.gw} className={`bx-stop ${r.gw === brief.gw ? "now" : ""}`}>
              <div className="bx-stop-gw">
                GW{r.gw}
                {r.isBreak && <i className="bx-brk" title="Follows an international break">break</i>}
              </div>
              <div className="bx-stop-pts">{r.pts.toFixed(0)}</div>
              <div className="bx-stop-meta">
                <span className="bx-stop-c" title="Likely captain">{r.capt.n}</span>
                <span className="bx-stop-ft" title="Free transfers available if you roll">{r.ft} FT</span>
              </div>
              {r.chip && <div className="bx-stop-chip">{r.chip.title} +{r.chip.gain.toFixed(0)}</div>}
              {r.swing.map((sw, i) => (
                <div key={i} className={`bx-stop-swing ${sw.dir}`}>
                  {sw.team} fixtures {sw.dir}
                </div>
              ))}
            </div>
          ))}
        </div>
        {brief.brk && (
          <p className="bx-note">
            <b>GW{brief.brk.gw} follows an international break.</b> Two clear
            weeks to see injuries resolve and prices settle — the cheapest point
            in the run to restructure, and a reason not to force a move in
            GW{brief.brk.before}.
          </p>
        )}
      </section>

      {/* ---- chips ------------------------------------------------------ */}
      <section className="bx-sec">
        <h2 className="bx-sec-h">Chips</h2>
        <div className="bx-chipsheld">
          {[["wc", "Wildcard"], ["fh", "Free Hit"], ["bb", "Bench Boost"], ["tc", "Triple Captain"]]
            .map(([k, label]) => (
              <button key={k} className={`bx-held ${spent.includes(k) ? "gone" : ""}`}
                onClick={() => toggleChip(k)}
                title={spent.includes(k) ? "Already played — tap to restore" : "Still available — tap if you have used it"}>
                {label}
              </button>
            ))}
        </div>
        {Object.entries(brief.chips).map(([k, c]) => (
          <div key={k} className={`bx-chip ${c.worth ? "worth" : ""}`}>
            <div className="bx-chip-t">
              {c.title}
              <span className="bx-chip-w">
                {c.worth ? `GW${c.best.gw}` : "hold"}
              </span>
            </div>
            <p className="bx-chip-why">{c.why}</p>
            {showMaths && <p className="bx-chip-note">{c.note}</p>}
          </div>
        ))}
        {!Object.keys(brief.chips).length && (
          <p className="bx-note">Every chip has been played.</p>
        )}
      </section>

      {/* ---- the arithmetic, for those who want it ---------------------- */}
      <section className="bx-sec">
        <button className="bx-maths-btn" onClick={() => setShowMaths((m) => !m)}>
          {showMaths ? "Hide the arithmetic" : "Show the arithmetic"}
        </button>
        {showMaths && (
          <div className="bx-maths">
            <div className="bx-maths-row">
              <span>Eleven, projected</span><b>{s.parts.base.toFixed(2)}</b>
            </div>
            <div className="bx-maths-row">
              <span title="What the bench recovers when a starter plays no minutes">
                Autosub cover</span><b>+{s.parts.cover.toFixed(2)}</b>
            </div>
            <div className="bx-maths-row">
              <span title="The captain's second helping, falling to the vice if he plays nothing">
                Armband</span><b>+{s.parts.armband.toFixed(2)}</b>
            </div>
            {s.parts.bench > 0 && (
              <div className="bx-maths-row"><span>Bench Boost</span><b>+{s.parts.bench.toFixed(2)}</b></div>
            )}
            <div className="bx-maths-row total">
              <span>Expected points</span><b>{s.ev.toFixed(2)}</b>
            </div>
            <p className="bx-note">
              Differences below <b>{TOLERANCE.toFixed(2)}</b> points are treated
              as ties and broken on minutes security instead. The model's own
              error one week out is around 2 points a player, so a gap of a
              tenth is not a difference this model is entitled to an opinion
              about.
            </p>
            <p className="bx-note">
              Substitutes are ranked by what they are worth <em>given they
              play</em>, not by projection. An automatic substitution only
              happens for a player who was on the pitch, so his chance of
              featuring has already done its work by then.
            </p>
          </div>
        )}
      </section>

      </div>
      </div>
    </div>
  );
}

function Move({ m, gi }) {
  return (
    <div className="bx-move">
      <div className="bx-move-side out">
        <Jersey team={m.out.t} size={22} />
        <span>{m.out.n}</span>
        <Fx team={m.out.t} gi={gi} />
      </div>
      <span className="bx-move-arrow">→</span>
      <div className="bx-move-side in">
        <Jersey team={m.in.t} size={22} />
        <span>{m.in.n}</span>
        <Fx team={m.in.t} gi={gi} />
      </div>
      <div className="bx-move-n">
        <b>{m.gain >= 0 ? "+" : ""}{m.gain.toFixed(1)}</b>
        <i>{m.cost >= 0 ? `costs ${money(m.cost)}` : `frees ${money(-m.cost)}`}</i>
      </div>
    </div>
  );
}
