import React from "react";
import { DATA } from "./logic.js";
import { seasonStrategy } from "./manager.js";

/**
 * THE PLAN, AT THE TOP, IN ONE PLACE.
 *
 * What this replaces: a page that re-answered "should I wildcard?" every
 * gameweek and shouted the answer, so a chip you can play once all season was
 * being recommended eight weeks running. A one-shot asset needs one
 * recommendation — a week — and then silence.
 *
 * So: one line per chip naming its best week, one line for the transfer, and a
 * control to strike a chip off once you have played it. Nothing here repeats
 * anything below it; everything below is about THIS week, and this is about the
 * season.
 */

const CHIP_LABEL = { wc: "Wildcard", fh: "Free Hit", bb: "Bench Boost", tc: "Triple Captain" };
const ALL_CHIPS = ["wc", "fh", "bb", "tc"];

const VERDICT_TONE = {
  ROLL: "roll", WAIT: "roll", TRANSFER: "act", HIT: "warn",
};

export function StrategyBar({ squad, gi, free, setFree, spent, setSpent, planWeeks }) {
  // Recomputes whenever the PLAN changes, not just the squad — a transfer
  // locked into a later week has to move the chip numbers above it.
  const planKey = React.useMemo(
    () => (planWeeks || []).map((w) => w.squad.join(".")).join("|"),
    [planWeeks]);
  const s = React.useMemo(
    () => seasonStrategy(squad, gi, { free, spent, span: 12, planWeeks }),
    [squad.join(","), gi, free, spent.join(","), planKey]);
  if (!s) return null;

  const toggle = (c) =>
    setSpent(spent.includes(c) ? spent.filter((x) => x !== c) : [...spent, c]);

  // A chip that peaks THIS week belongs in the headline, not in a separate
  // panel that says something different. The page used to run "Roll your
  // transfer" directly above "ACT: Play Bench Boost" — two answers to one
  // question, and no way for a reader to tell whether they disagreed.
  const chipNow = s.chips.find((c) => c.worth && c.gw === s.gw && !spent.includes(c.key));
  const tone = chipNow ? "act" : (VERDICT_TONE[s.transfer.verdict] || "roll");

  return (
    <section className="strat">
      <div className="strat-head">
        <h2>Your plan</h2>
        <div className="strat-ft">
          <span>Free transfers</span>
          <div className="strat-ftpick">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={free === n ? "on" : ""}
                onClick={() => setFree(n)} aria-pressed={free === n}>{n}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ---- this week ---- */}
      <div className={`strat-now t-${tone}`}>
        <span className="strat-now-k">GW{s.gw}</span>
        <div className="strat-now-b">
          <b>
            {chipNow ? `Play your ${chipNow.title}` : s.transfer.headline}
          </b>
          <p>
            {chipNow
              ? `${chipNow.why} ${s.transfer.verdict === "ROLL" || s.transfer.verdict === "WAIT"
                  ? "Roll your transfer alongside it — nothing available is worth spending."
                  : `Then: ${s.transfer.headline.toLowerCase()}.`}`
              : s.transfer.why[0]}
          </p>
        </div>
      </div>

      {/* ---- move against roll, both priced ----
          Always shown, and rolling carries a score of its own. Leaving "hold"
          as the unstated default made it look like the absence of a decision;
          some weeks banking the transfer really is the better of the two, and
          you cannot see that unless both are on the same axis. */}
      <div className="strat-opts">
        {(s.transfer.options || []).map((o) => {
          const best = o.net === Math.max(...(s.transfer.options || []).map((x) => x.net));
          if (o.net === -Infinity) return null;
          return (
            <div key={o.key} className={`strat-opt ${best ? "win" : ""}`}>
              <div className="strat-opt-h">
                <span className="strat-opt-k">{o.key === "MOVE" ? "Best move" : "Roll"}</span>
                {best && <span className="strat-opt-w">better</span>}
              </div>
              <b className="strat-opt-l">{o.label}</b>
              <div className="strat-opt-n">
                <span className={o.net >= 0 ? "up" : "down"}>
                  {o.net >= 0 ? "+" : "−"}{Math.abs(o.net).toFixed(1)}
                </span>
                <i>net points</i>
              </div>
              <p className="strat-opt-d">{o.detail}</p>
            </div>
          );
        })}
      </div>

      {/* ---- the chips, one week each ---- */}
      <div className="strat-chips">
        {ALL_CHIPS.map((key) => {
          const row = s.chips.find((c) => c.key === key);
          const used = spent.includes(key);
          return (
            <div key={key} className={`strat-chip ${used ? "used" : row?.worth ? "on" : ""}`}>
              <div className="strat-chip-t">
                <span>{CHIP_LABEL[key]}</span>
                <button className="strat-chip-x" onClick={() => toggle(key)}
                  title={used ? "Mark as still available" : "Mark as already played"}>
                  {used ? "played" : "mark used"}
                </button>
              </div>
              {used ? (
                <div className="strat-chip-w gone">Played</div>
              ) : !row ? (
                <div className="strat-chip-w">—</div>
              ) : row.firm ? (
                <>
                  <div className="strat-chip-w best">GW{row.gw}</div>
                  <p className="strat-chip-d">
                    +{row.gain.toFixed(1)} pts{row.player ? ` · ${row.player.n}` : ""}
                  </p>
                </>
              ) : row.worth ? (
                <>
                  <div className="strat-chip-w">GW{row.gw}</div>
                  <p className="strat-chip-d">
                    +{row.gain.toFixed(1)}, but GW{row.near.filter((g) => g !== row.gw).join(" and GW")} are close — not settled yet.
                  </p>
                </>
              ) : (
                <>
                  <div className="strat-chip-w hold">Hold</div>
                  <p className="strat-chip-d">
                    Best week so far is GW{row.gw} at +{row.gain.toFixed(1)} — not enough to spend it on.
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>

      {s.brk && (
        <p className="strat-note">
          <b>GW{s.brk.gw} follows an international break.</b> Injuries resolve
          and prices settle across it, so it is the cheapest week in the run to
          restructure — and a reason not to force a move in GW{s.brk.before}.
        </p>
      )}
    </section>
  );
}
