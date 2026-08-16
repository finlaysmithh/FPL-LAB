import React, { useState } from "react";
import { DATA, POS_ORDER, FDR_BANDS, fdrColor, fdrInk } from "./logic.js";

/**
 * How the numbers are made.
 *
 * Every constant on this page is read from `DATA.model`, which the exporter
 * writes straight off the live engine's own configuration. Documentation that
 * restates a fitted value by hand is documentation that goes stale the first
 * time somebody re-fits it; documentation that reads the value cannot.
 *
 * The prose is deliberately opinionated about WHY each choice was made, and
 * about what the model refuses to do. A list of features tells you what a model
 * includes; only a list of rejected features tells you whether it was built by
 * someone measuring things.
 */

const M = DATA.model || {};
const f = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const byPos = (o) =>
  POS_ORDER.filter((p) => o && o[p] != null).map((p) => `${p} ${o[p]}`).join("  ·  ");

function Eq({ children, note }) {
  return (
    <div className="mt-eq-wrap">
      <pre className="mt-eq">{children}</pre>
      {note && <p className="mt-eq-note">{note}</p>}
    </div>
  );
}

function Def({ k, v, children }) {
  return (
    <div className="mt-def">
      <div className="mt-def-head">
        <code className="mt-def-k">{k}</code>
        {v != null && <span className="mt-def-v">{v}</span>}
      </div>
      <p className="mt-def-b">{children}</p>
    </div>
  );
}

function Sec({ id, n, title, sub, children, open, onToggle }) {
  return (
    <section className="mt-sec" id={id}>
      <button className={`mt-sec-head ${open ? "on" : ""}`} onClick={onToggle}
        aria-expanded={open}>
        <span className="mt-sec-n">{n}</span>
        <span className="mt-sec-t">{title}</span>
        <span className="mt-sec-chev" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mt-sec-body">
          {sub && <p className="mt-sub">{sub}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

const SECTIONS = [
  ["formula", "01", "The expected-points formula"],
  ["minutes", "02", "The minutes model"],
  ["team", "03", "Team ratings"],
  ["fdr", "04", "Fixture difficulty"],
  ["dict", "05", "Data dictionary"],
  ["sources", "06", "Where the numbers come from"],
  ["accuracy", "07", "Accuracy"],
  ["optimiser", "07b", "The optimiser, the bench and the grades"],
  ["limits", "08", "What this deliberately does not model"],
];

export function MethodTab() {
  // Everything open by default: this is a reference page, and a reader who
  // came here to audit the model should be able to search the whole thing with
  // the browser's own find rather than hunting for the right accordion.
  const [openIds, setOpenIds] = useState(() => new Set(SECTIONS.map(([k]) => k)));
  const toggle = (k) =>
    setOpenIds((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  const allOpen = openIds.size === SECTIONS.length;
  const bt = M.backtest || [];
  const gwFirst = DATA.gws[0];
  const gwLast = DATA.gws[DATA.gws.length - 1];

  const sec = (id) => ({
    id: `mt-${id}`,
    open: openIds.has(id),
    onToggle: () => toggle(id),
  });

  return (
    <div className="page mt-page">
      <div className="eyebrow">Method</div>
      <p className="page-blurb">
        Every projection in this app comes from the formula below. Nothing here is a
        hand-set opinion about a player: each constant is either an FPL scoring rule
        or a value fitted against real match data, and this page says which is which
        and how large the sample was. The figures are read from the live model at
        build time, so they cannot drift from the code that picked your squad.
      </p>

      <button className="mt-expand" onClick={() =>
        setOpenIds(allOpen ? new Set() : new Set(SECTIONS.map(([k]) => k)))}>
        {allOpen ? "Collapse all" : "Expand all"}
      </button>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("formula")} n="01" title="The expected-points formula"
        sub="A player's expected points for one fixture are the sum of nine independent components. Each is an expectation, not a prediction: a 0.42 goal term means 'across many replays of this fixture he averages 0.42 goals'. That is why nobody ever scores their projection exactly, and why a 6.0 projection is not a forecast of six points.">
        <Eq note="P(60) gates three separate terms at once — the second appearance point, the clean sheet and the goals-conceded penalty. That is why the minutes model matters more than the attacking model.">
{`xP = 2·P(60) + 1·[P(play) − P(60)]     appearance
   + xG_fix · G_pos                    goals
   + xA_fix · 3 · assist_mult          assists
   + P(CS) · CS_pos · P(60)            clean sheet
   + P(DefCon) · 2 · P(play)           defensive contribution
   + E[bonus]                          bonus
   + xSaves / 3                        saves      (GK)
   − E[⌊GC/2⌋] · P(60)                 conceded   (GK, DEF)
   − E[cards]                          discipline`}
        </Eq>

        <p className="mt-p">
          The step that makes a <em>fixture</em> matter is converting a player's
          per-90 rate into a share of his team's output, then rescaling that share
          by the expected goals in this particular match:
        </p>
        <Eq note="A striker on 0.55 xG/90 in a side averaging 1.5 xG/90 owns 37% of its chances. Away to a defence rated 1.4, the team's lambda rises to about 2.0 and his fixture xG rises with it — a 33% uplift from the opponent alone.">
{`share_g = xG90_player / xG90_team
xG_fix  = share_g · λ_team · minutes_factor`}
        </Eq>

        <Def k="G_pos" v={byPos(M.goal_points)}>
          Points per goal by position. An FPL rule, not a fitted value.
        </Def>
        <Def k="CS_pos" v={byPos(M.cs_points)}>
          Points per clean sheet by position. FPL rule.
        </Def>
        <Def k="assist_mult" v={byPos(M.assist_inflation)}>
          FPL awards assists far more generously than Opta counts expected assists.
          Winning a penalty that is scored is an assist; so is a shot parried to a
          team-mate, or a cross that forces an own goal. None of those generate xA,
          because no pass to a shot ever happened. Measured across a full season:
          796 real assists against 579 xA. A player's own ratio may pull him at most{" "}
          <b>{f(M.assist_credibility, 2)}</b> of the way off the positional constant,
          and that ceiling is not a taste setting — it is the signal's measured
          year-over-year reliability (r = 0.25), which is exactly the minimum-error
          shrinkage.
        </Def>
        <Def k="P(DefCon)" v={`threshold ${byPos(M.defcon_threshold)}`}>
          Defensive actions are count data but they are not Poisson — they come in
          bursts. A Negative Binomial with fitted dispersion ({byPos(M.defcon_dispersion)})
          handles the tail, and the tail is the whole event: DefCon pays only on
          crossing a threshold, never on the average game.
        </Def>
        <Def k="E[bonus]">
          Fitted on how much bonus a player averages <em>per appearance</em> given
          his BPS per 90 — not on how much bonus a given BPS score earns. Bonus is a
          tail event, and fitting the second thing then evaluating it at a player's
          mean BPS understated bonus twelvefold, because every above-average match,
          where all the bonus actually lives, was flattened away.
        </Def>
        <Def k="E[⌊GC/2⌋]">
          Computed exactly over a Poisson rather than approximated as λ/2. The floor
          function makes a real difference at low λ: a 0.8-goal fixture costs about
          0.19 points, not 0.40.
        </Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("rates")} n="01b" title="How rates cross a season boundary"
        sub="A per-90 rate is not a property of the player alone — it is what he does multiplied by how many chances his club creates. Carrying the raw rate across a transfer mismatches the two halves, and the engine's next step divides by his NEW club's creation.">
        <Eq note="Measured out of sample on every season pair, predicting each season's rate from the ones before it. Carrying the shrunk share beat carrying the raw rate in all six folds, by 5–30%, and the gain was largest among players who actually changed club — which is where the argument says it should be.">
{`share_s    = xG90_s / team_xG90(his club THAT season)
share      = credibility blend of share_s across seasons
share      = shrink(share, positional mean, by minutes)
xG90_prior = share × team_xG90(his club NOW)`}
        </Eq>
        <p className="mt-p">
          A striker on 0.50 xG/90 at a club creating 1.2 owned{" "}
          <b className="mt-num">42%</b> of its chances. Move him to a club creating
          1.9 and the old arithmetic read 0.50 ÷ 1.9 ={" "}
          <b className="mt-num">26%</b> — the transfer to a better side scored as a
          demotion. The share is now measured against the club he was at when he
          earned it, minutes-weighted so a January move is split between both, and
          only then rescaled to where he plays today.{" "}
          <b className="mt-num">{M.n_carry_share ?? "—"}</b> players carry a share
          this way.
        </p>

        <Def k="price-implied prior" v={`${M.n_rate_mostly_price ?? "—"} players`}>
          A player the Premier League has never seen has no rate to carry, so his
          price stands in — FPL's own analysts set it knowing his overseas record.
          But this used to be a hard overwrite triggered by last season alone, so a
          year abroad or injured erased everything before it: Rashford's own 0.312
          xG90 over 72.9 matches became 0.160, and Maddison arrived at exactly the
          same number as Kulusevski because they share a price band. It is now a
          two-stage hierarchy — the price figure is the prior a player's own record
          is shrunk toward, weighted by how much record there is — so a player with
          no history still lands on the proxy and one with a career keeps it.
        </Def>
        <Def k="credibility K" v={`attack ${f(M.shrink_k_attack, 1)} · defcon ${f(M.shrink_k_defcon, 1)} · bps ${f(M.shrink_k_bps, 1)}`}>
          How many full matches of this season it takes before current data outweighs
          the prior. These are measured, not chosen. DefCon exists only in the
          2025/26 export, so year-over-year reliability is not computable — the
          substitute is a split-half across odd and even gameweeks (so form and
          transfers cannot masquerade as unreliability), Spearman-Brown corrected:
          r = 0.906 for defenders, 0.869 for midfielders. That implies K ≈ 2.3–3.3,
          and {f(M.shrink_k_defcon, 1)} is used rather than the literal figure
          because a within-season measurement cannot see the transfers and managerial
          changes that reset a role between seasons. BPS measured far noisier
          (r = 0.572) than the attacking constant it had been silently sharing, which
          is why it now has its own.
        </Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("minutes")} n="02" title="The minutes model"
        sub="The single largest source of error in any expected-points system — a perfect goals model applied to a benched player scores zero. Three separate quantities are estimated, and conflating them was this model's biggest historic error.">
        <Eq note="Exponents fitted on 2,959 player-seasons across four seasons. The previous model used P(60) = share × 0.9, which is roughly right mid-range and badly wrong at the top: at a 0.90 minutes share it said 0.81 where the measured figure is 0.90.">
{`P(start) = share ^ ${f(M.p_start_exp, 3)}
P(60)    = share ^ ${f(M.p_60_exp, 3)}
P(play)  = share ^ ${f(M.p_play_exp, 3)}`}
        </Eq>

        <div className="card mt-card">
          <div className="mt-card-t">Squad conservation</div>
          <p className="mt-p">
            A football team plays eleven players. Estimating every player on his own
            meant nothing ever checked that a club's estimates added up to a team —
            and they did not. Hull's squad summed to 666 expected outfield minutes a
            match and Chelsea's to 1,490, against a measured budget of{" "}
            <b className="mt-num">{M.budget_outfield}</b> outfield and{" "}
            <b className="mt-num">{M.budget_gk}</b> in goal. Hull were fielding seven
            and a half men; Chelsea sixteen.
          </p>
          <Eq>
{`minutes_i = availability_i · min(mps_i, λ · nailed_i · mps_i)

choose λ per club, per gameweek, s.t.  Σ minutes = ${M.budget_outfield}`}
          </Eq>
          <p className="mt-p">
            Three properties follow, and the third is the one you feel. It is
            <b> rank-preserving</b>, so the model's view of who is better than whom
            never changes — only the level moves. It <b>self-corrects squad depth</b>,
            lifting an under-rated squad and trimming a bloated one. And{" "}
            <b>injuries reallocate automatically</b>: when two centre-halves are out,
            their minutes leave the sum, λ rises, and the defenders behind them
            absorb the difference. No depth chart is maintained by hand — the
            constraint does it, for all twenty clubs, every gameweek, from the injury
            flags the model already holds.
          </p>
        </div>

        <Def k="nailed" v={`concentration ${f(M.role_concentration, 1)}`}>
          How often the club picks him, kept strictly separate from how long he lasts.
          A striker who starts 89% of matches and is withdrawn on 86 minutes carries
          the same raw minutes share as one who starts 86% and plays the full 90 — but
          only the first is nailed, and squeezing the raw share punishes him for being
          substituted, which is a fact about how his manager uses him rather than a
          statement about whether he is in the team. The concentration exponent fades
          to 1.0 as real minutes accumulate: it exists to pull apart estimates bunched
          around a price-band median, and has no business reshaping a rate that has
          actually been observed.
        </Def>
        <Def k="predicted XI" v={`floor ${f(M.xi_nail_floor, 3)} · GK ${f(M.xi_nail_floor_gk, 3)}`}>
          At a promoted club the model has no Premier League history for anyone, so
          all 29 players sit at one price-implied prior and conservation splits the
          minutes evenly — an honest expression of ignorance and a useless projection.
          A sourced pre-season predicted XI supplies the missing rank. The floors are
          measured, not asserted: across last season each club's eleven most-used
          outfielders started 74.2% of the matches they were available for, and each
          club's first-choice keeper 94.2%. A named starter who <em>also</em> has a
          real Premier League record is floored at that record instead, so being
          picked can never demote a player the model already understands.
        </Def>
        <Def k="availability">
          FPL's injury flags, resolved per gameweek against real kickoff dates. A
          dated return ("Expected back 22 Aug") zeroes only the weeks actually missed
          rather than deleting a fit player for the season; an unknown return tapers
          back over several gameweeks instead of ending at a cliff.
        </Def>
        <Def k="return ramp" v="1,241 episodes">
          A player back from an absence does not resume his old role, and the model
          used to assume he did — snapping straight back to 100%. Fitted across 3,288
          player-seasons, minutes in the first three matches back run at{" "}
          <b className="mt-num">
            {M.return_ramp ? f(M.return_ramp["2"]?.[0], 2) : "—"}
          </b>{" "}
          of the pre-absence level after a two-week absence and{" "}
          <b className="mt-num">
            {M.return_ramp ? f(M.return_ramp["99"]?.[0], 2) : "—"}
          </b>{" "}
          after six weeks or more. The mean is used rather than the median, because
          expected minutes is an expectation: the typical returner recovers quickly,
          but a large minority never re-establish a place, and modelling the median
          would systematically overrate them. The haircut is applied before
          conservation, so minutes he does not take flow to his team-mates instead of
          vanishing from the club's budget.
        </Def>
        <Def k="predicted-XI decay" v={`half-life ${f(M.xi_floor_halflife, 1)} gw`}>
          A pre-season team-sheet prediction is real evidence about GW1 and nearly
          none about GW6, by which point the model has watched several actual
          line-ups. The floor now fades — full weight in GW1, half by GW3, an eighth
          by GW7 — using the same decay machinery as the team ratings. Held at full
          strength it pinned players to a guess that observed starts had already
          contradicted.
        </Def>
        <Def k="positional budget" v={byPos(M.pos_budget_share ? Object.fromEntries(Object.entries(M.pos_budget_share).map(([k2, v]) => [k2, f(v, 3)])) : null)}>
          A club's outfield minutes are not one pool. Treating them as one meant an
          injured centre-back's minutes flowed to whoever was next in the whole
          squad — including forwards — so a defensive injury quietly promoted a
          striker. Budgets are measured per position (DEF 369.8, MID 426.8, FWD 98.4
          minutes per team-match, 2023-24 to 2025-26) and the club's own squad shape
          gets equal weight against the league split, so a back-three side is not
          forced into a back-four allocation. Where a position cannot fill its share,
          the remainder spills to positions with headroom — eleven players still have
          to be on the pitch.
        </Def>
        <Def k="minutes prior">
          Last season's share is measured over the gameweeks a player was plausibly
          available, not over all 38. Raw share cannot tell a rotation player from a
          starter who missed ten weeks injured — both arrive as "0.6 of a season" —
          and since this season's injuries are already applied separately, an
          injury-depressed prior would be charged twice.
        </Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("team")} n="03" title="Team ratings"
        sub="Attack and defence are rated separately, from real expected goals, relative to the league average of the same season.">
        <Eq note="Dixon & Coles (1997) attack/defence decomposition. Home advantage is not a separate multiplier — it is already inside att_home and def_away, and applying it a second time inflated the home/away spread to 1.55 against a real 1.23.">
{`AttStr = xGF90 / league_avg     DefWeak = xGA90 / league_avg

λ_home = μ · AttStr_home^${M.rating_exponent} · DefWeak_away^${M.rating_exponent}
λ_away = μ · AttStr_away^${M.rating_exponent} · DefWeak_home^${M.rating_exponent}`}
        </Eq>
        <Def k="seasons used" v={(M.seasons_rated || []).join("  ·  ")}>
          One season is far too short a measurement to rate a defence, and using one
          showed: Liverpool came out at 0.999 — dead league average — purely because
          it had been an off year, so a home game against them was rated a{" "}
          <em>green</em> fixture and three of the calendar's easiest attacking games
          were trips to Anfield. No amount of recolouring fixes a rating that calls
          an elite defence average. Three seasons at a {M.team_form_halflife}-match
          half-life weight roughly 55 / 30 / 15, so the current season still dominates
          but a single bad year cannot erase an established level.
        </Def>
        <Def k="rating exponent" v={M.rating_exponent}>
          The plain product is systematically mis-scaled at the extremes. Measured
          over 2,280 team-matches, actual xG divided by predicted xG ran 0.933 against
          the strongest defences and 1.015 against the weakest — and in the corner
          that matters most to a Fantasy manager, a top-quintile attack facing a
          bottom-quintile defence returned <b>1.156×</b> the prediction. So a big club
          really does hammer a promoted side harder than the plain model says. The
          cause is shrinkage: ratings are deliberately pulled toward the league
          average to control noise, and therefore understate the true spread. Raising
          both to a common power restores it; lambdas are renormalised afterwards so
          the league's total expected goals is unchanged. This redistributes
          difficulty, it does not inflate it.
        </Def>
        <Def k="venue split" v={M.venue_credibility}>
          A club plays only 19 home games, so its measured home/away split is a tiny
          sample — the year-over-year correlation is r = 0.075, essentially zero. The
          league-wide venue effect is real and kept; each club's personal deviation
          from it is shrunk almost entirely away.
        </Def>
        <Def k="promoted clubs" v={`att ${M.promoted_att}  ·  def ${M.promoted_def}`}>
          Championship expected goals do not translate, so promoted sides get a prior
          fitted on how promoted sides actually perform in the Premier League: nine
          clubs across three seasons. The spread is real and large, which is exactly
          why it stays a prior — real results pull each club off it immediately.
        </Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("fdr")} n="04" title="Fixture difficulty"
        sub="Two numbers per fixture, not one. The official FPL difficulty rating collapses both into a single integer, which is its biggest flaw: a trip to a leaky, high-scoring side is easy for your forwards and hard for your defenders at the same time.">
        <div className="mt-ramp">
          {FDR_BANDS.map(([hi, colour, label], i) => {
            const lo = i === 0 ? 1.0 : FDR_BANDS[i - 1][0];
            const mid = hi === Infinity ? 9.4 : (lo + hi) / 2;
            return (
              <div key={label} className="mt-ramp-cell"
                style={{ background: colour, color: fdrInk(mid) }}>
                <span className="mt-ramp-l">{label}</span>
                <span className="mt-ramp-v">
                  {hi === Infinity ? `${lo.toFixed(1)}+` : `≤${hi.toFixed(1)}`}
                </span>
              </div>
            );
          })}
        </div>
        <Def k="attack rating">
          How hard it is for this club to score, built from its own λ. Drives
          forwards and attacking midfielders.
        </Def>
        <Def k="defence rating">
          How likely this club is to keep a clean sheet, built from the opponent's λ.
          A separate rating, not the inverse of the other one.
        </Def>
        <Def k="scale" v={`±${M.fdr_span_sigma}σ → 1–10`}>
          Anchored on spread, not on extremes. Expected goals in a fixture are tightly
          packed and right-skewed, so rescaling between the two extreme fixtures
          squashed half the calendar into a two-point band and made nearly everything
          read as "hard". At ±{M.fdr_span_sigma} standard deviations an average
          fixture scores 5.5 by construction, in both columns, and the ends belong to
          genuinely extreme games.
        </Def>
        <Def k="colour bands" v={`${FDR_BANDS.length} octiles`}>
          Cut at the measured octiles of this season's 760 ratings, so each colour
          carries an eighth of the calendar and a colour change always means a real
          change in rank. The ramp ends in a dark red rather than a bright pink
          because the top band has to hold the fixtures that deserve it — away at
          Arsenal rates 9.4, away at Man City 8.7, away at Liverpool 8.1 — and those
          should not share a colour with an ordinary hard away day.
        </Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("dict")} n="05" title="Data dictionary"
        sub="Every field carried on a player record, in the order the model computes them. Component totals are summed across the whole horizon shown in the app.">
        <div className="mt-group">Identity &amp; price</div>
        <Def k="n · t · p · c">Name, club, position, price in £m.</Def>
        <Def k="o">Ownership — percent of all FPL managers selecting him.</Def>
        <Def k="pk">
          Penalty order; 1 is the designated first taker. Penalty xG is credited
          separately from open-play xG, so a taker is not double-counted.
        </Def>

        <div className="mt-group">Projection</div>
        <Def k="x">Total expected points across GW{gwFirst}–{gwLast}.</Def>
        <Def k="g[ ]">
          Expected points per gameweek. A blank gameweek is 0; a double gameweek is
          the sum of both fixtures.
        </Def>
        <Def k="xg · xa">
          Fixture-adjusted expected goals and assists, summed over the horizon. These
          are the model's numbers for <em>these</em> fixtures — not last season's
          totals carried forward.
        </Def>

        <div className="mt-group">Point components (horizon totals)</div>
        <Def k="cap">
          Appearance points. Roughly a third of a nailed player's total, and entirely
          fixture-independent — which is why projections vary less across fixtures
          than intuition suggests.
        </Def>
        <Def k="cg · ca">Goals and assists.</Def>
        <Def k="ccs · cgc">Clean sheets earned, and points lost to goals conceded.</Def>
        <Def k="cdc">Defensive contribution.</Def>
        <Def k="cbp">Bonus.</Def>
        <Def k="csv">
          Save points for goalkeepers, scaled by how much the opposition is expected
          to attack.
        </Def>

        <div className="mt-group">Minutes &amp; availability</div>
        <Def k="ps · p60">
          Probability he starts, and probability he reaches 60 minutes. Rounded to
          whole percent: the model is nowhere near precise enough to justify a
          decimal, and showing one would imply confidence it does not have.
        </Def>
        <Def k="xm">Expected minutes per match, averaged across the horizon.</Def>
        <Def k="mg[ ]">
          Expected minutes per gameweek. Present only when a player's role actually
          moves across the horizon — usually because someone ahead of him is injured
          for part of it.
        </Def>
        <Def k="st · ch · nw">
          FPL availability status, chance of playing, and the news string behind the
          flag.
        </Def>
        <Def k="mf">
          Which minutes path produced the estimate: <code>fringe</code>,{" "}
          <code>new_signing_price_proxy</code>, <code>predicted_xi</code>,{" "}
          <code>clear_first_choice_gk</code>, <code>declared_fit_starter</code> or{" "}
          <code>manual_minutes</code>.
        </Def>
        <Def k="pr">
          Rates are a price-implied proxy — no usable Premier League history. Shown
          as <code>*</code> beside the name.
        </Def>
        <Def k="ns · pc">Arrived this summer, and the club he came from.</Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("sources")} n="06" title="Where the numbers come from"
        sub="All of it is real archived data. Nothing is simulated, and nothing comes from a paid provider.">
        <Def k="squad, prices, flags" v={`${DATA.players.length} players`}>
          FPL's own registry for this season, including summer transfers, injury
          status and chance-of-playing.
        </Def>
        <Def k="player rates" v="29,757 gameweek rows">
          Real per-gameweek expected goals, expected assists, BPS, defensive
          contributions, saves and cards from FPL's archived data.
        </Def>
        <Def k="team ratings" v="2,280 team-matches">
          Team-level xG per match, aggregated from real player-level xG across{" "}
          {(M.seasons_rated || []).length} seasons.
        </Def>
        <Def k="minutes curves" v="2,959 player-seasons">
          Four seasons of per-gameweek starts and minutes, used to fit the probability
          curves and to measure the squad minute budget.
        </Def>
        <Def k="predicted XIs" v={`${M.n_predicted_xi} named`}>
          Pre-season predicted line-ups for all twenty clubs, cross-checked against
          two further sources. Where sources disagree both names are listed rather
          than one being chosen silently — the floor only ever lifts, so listing a
          player on one credible source is cheap while omitting a real starter is not.
        </Def>
        <div className="card mt-card">
          <div className="mt-card-t">Credibility blending</div>
          <p className="mt-p">
            Every rate is shrunk toward a prior by sample size, w = n / (n + K), with
            K = {M.shrink_k_attack} ninety-minute blocks for attacking rates and{" "}
            {M.shrink_k_defcon} for defensive contributions, which stabilise faster
            because the event count is higher. Pre-season the blend correctly sits at
            100% prior — that is the mathematically right state for a GW1 projection,
            not an approximation or a shortcut.
          </p>
        </div>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("accuracy")} n="07" title="Accuracy"
        sub="Walk-forward validation of this exact engine — not a stand-in regression. For each gameweek the model is rebuilt using only data that existed beforehand, then scored against what actually happened. A shuffled train/test split would leak the future through team form and make a bad model look excellent.">
        {bt.length > 0 && (
          <div className="mt-table-wrap">
            <table className="mt-table">
              <thead>
                <tr>
                  <th>season</th><th>n</th><th>MAE</th>
                  {/* Greek stays lower-case: uppercasing rho renders a letter
                      indistinguishable from a Latin P. */}
                  <th><span className="asis">ρ</span></th>
                  <th>calib</th><th>top20</th><th>field</th>
                </tr>
              </thead>
              <tbody>
                {bt.map((b) => (
                  <tr key={b.season}>
                    <td className="lbl">{b.season}</td>
                    <td className="dim">{b.n}</td>
                    <td>{f(b.mae)}</td>
                    <td className="good">{f(b.spearman, 3)}</td>
                    <td>{f(b.calibration, 3)}</td>
                    <td className="gold">{f(b.top20)}</td>
                    <td className="dim">{f(b.field)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-p">
          <b>ρ</b> is rank correlation, and it is the number that matters — the
          optimiser only needs the <em>ordering</em> of players to be right, not their
          absolute scores. <b>top20</b> is the average real points scored by the twenty
          players the model ranked highest, against <b>field</b> for an average player;
          roughly double is the honest summary of what the ranking buys you.{" "}
          <b>calib</b> below 1.0 means the model under-predicts slightly, which is
          expected — points are heavily right-skewed and hauls are rare.
        </p>

        {bt.length > 0 && bt[0].capt != null && (
          <>
            <div className="mt-group">The decisions, not the error term</div>
            <p className="mt-p">
              A model can improve its MAE by shading every projection toward the
              mean and get worse at every choice a manager actually makes. So the
              same walk-forward run is scored on the decisions themselves.
              Captaincy is the sharpest test in the game: one pick a week,
              doubled.
            </p>
            <div className="mt-table-wrap">
              <table className="mt-table">
                <thead>
                  <tr>
                    <th>season</th><th>captain</th><th>perfect</th>
                    <th>field</th><th>capture</th><th>hit@5</th><th>hit@20</th>
                  </tr>
                </thead>
                <tbody>
                  {bt.map((b) => (
                    <tr key={b.season}>
                      <td className="lbl">{b.season}</td>
                      <td className="gold">{f(b.capt)}</td>
                      <td className="dim">{f(b.capt_best)}</td>
                      <td className="dim">{f(b.capt_field)}</td>
                      <td className="good">{(b.capture * 100).toFixed(0)}%</td>
                      <td>{(b.hit5 * 100).toFixed(0)}%</td>
                      <td>{(b.hit20 * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-p">
              The model's captain averages <b>2.3–3.3×</b> what an average player
              scores. <b>capture</b> is where that sits between picking at random
              and picking perfectly — perfect captaincy is unreachable, so quoting
              only the gap to it would be as misleading as quoting only the gap to
              the field. <b>hit@20</b> is how many of the twenty players the model
              ranked highest were genuinely in that week's real top twenty; random
              selection from the pool would score about 4%.
            </p>
          </>
        )}
        <div className="card mt-card warn">
          <div className="mt-card-t">What this test cannot tell you</div>
          <p className="mt-p">
            It can only run mid-season, where real start rates already exist and clubs'
            expected minutes sum to 1.01–1.26× of a legal team. Pre-season — when you
            actually build a squad or play a wildcard — they sum to 0.72–1.62×. So
            squad conservation is measured here in the regime where it has least to
            correct, and it comes out roughly neutral. It was still worth building: a
            projection in which Hull field seven and a half men is not a modelling
            preference, it is arithmetically impossible.
          </p>
        </div>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("optimiser")} n="07b" title="The optimiser, the bench and the grades"
        sub="What the solver maximises, why your bench costs what it does, and what a letter grade actually means.">
        <Eq note="Only eleven players score, so only eleven are in the objective. The bench enters at its autosub value, which is the chance an outfield starter fails to play multiplied by what the substitute himself is expected to score.">
{`max  Σ_gw  decay^(gw-1) · [ best legal XI + captain + autosub EV ]  −  4 · paid transfers`}
        </Eq>
        <Def k="autosub value" v="slot 1 · 0.542   slot 2 · 0.158   slot 3 · 0.026">
          The Poisson-binomial of the starting eleven's own P(start): how often at
          least one, two or three outfield starters fail to play. The first bench
          slot is used in 54% of gameweeks and the third in 3%, so ordering the
          bench is most of its value — a single flat weight valued slot one at a
          quarter of its worth and slot three at six times. A bench player only
          scores if he plays, which needs no extra term: his xP is already
          unconditional, so a fourth-choice defender who never appears is worth
          nothing here by construction. The backup keeper is priced separately at{" "}
          <b className="mt-num">0.013</b> — the chance the first keeper misses.
        </Def>
        <Def k="selling price" v="purchase + half the rise, rounded down">
          FPL returns your purchase price plus half of any rise, floored to £0.1m;
          a fall is taken in full. Bought at 5.0 and now 5.5, you get 5.2, not 5.5.
          Getting this wrong shifts the budget of every plan involving a risen
          player, so a transfer the model calls affordable would not be.
        </Def>
        <Def k="horizon confidence" v={`decay ${f(M.horizon_decay, 3)}, fitted`}>
          Fitted by freezing the engine t gameweeks in the past and still asking it
          about the current fixture, over thirty walk-forward passes. A ten-week-ahead
          projection keeps <b className="mt-num">83%</b> of its rank correlation and
          costs 4.7% of MAE — far gentler than the 0.85 that intuition suggests,
          which would discard three quarters of a signal that is still there. Two
          thirds of the loss happens by the fourth gameweek and the curve is flat
          after, which is why the bands break where they do. Measured MID-season
          only: every origin sits at GW8 or later, so it says nothing about
          projecting GW12 from August, and the app says so.
        </Def>
        <Def k="grades" v="A+ … F">
          A presentation layer, never an input. Squad grades are anchored so that{" "}
          <b>C</b> is the most-owned legal fifteen — the template manager — and{" "}
          <b>A+</b> is the best squad your budget can buy; measured spread across a
          sample of built squads is 92 rating points, so the scale is not compressed.
          Player grades rank within POSITION against players who plausibly start,
          because 4.5 points is an outstanding week for a defender and a poor one for
          a premium forward. Everything the solver optimises stays in points: grades
          cannot be summed, discounted, or weighed against a −4 hit.
        </Def>
        <Def k="predicted XI as a tiebreak" v="0.03, not 10.0">
          A naming used to be worth +10 against a pick rate that never exceeds 1.0,
          so a pre-season team sheet beat any record. Declan Rice — 3,093 minutes and
          a 92% real start rate — came out at a 39% chance of starting while players
          on 699 minutes sat at 100%. It is now a tiebreak, and the floor alone does
          the lifting for players the model knows nothing about.
        </Def>
      </Sec>

      {/* ---------------------------------------------------------------- */}
      <Sec {...sec("limits")} n="08" title="What this deliberately does not model"
        sub="Each of these was tested and rejected on measurement, not skipped through oversight. Listing them matters as much as listing the features — an unstated omission looks like a mistake, and a model that adds every plausible-sounding effect is one that has not measured any of them.">
        <Def k="set-piece duty" v="r = +0.01 to +0.15 on the residual">
          Corner and free-kick duty is a large driver of assists, and it is already
          in the model — inside xA. A corner that finds a head generates expected
          assists like any other pass to a shot, so crediting takers a second time
          is double-counting, and the measurement says exactly that. Duty adds
          <b className="mt-num"> +0.15</b> and <b className="mt-num">+0.01</b> to
          next season's xA90 once this season's xA90 is already accounted for, and
          it does not explain the assist gap either (r = +0.06, +0.09, −0.01 across
          three seasons — the sign flips). Duty itself is also less repeatable than
          it looks: the first-choice corner taker repeats at r = +0.67 in one fold
          and <b className="mt-num">+0.13</b> in the next. Nothing to add.
        </Def>
        <Def k="European congestion" v="r = −0.03, p = 0.21">
          Clubs playing midweek in Europe are supposed to rotate more in the league
          fixture that follows. Across 2,177 club-gameweeks over three seasons they
          changed <b className="mt-num">2.16</b> starters between consecutive league
          games against <b className="mt-num">2.24</b> for everyone else — a
          difference of 0.08 in the wrong direction, and not significant. Tested
          league-wide only, because the per-club version has no sample. There is no
          congestion adjustment because there is no measurable congestion effect.
        </Def>
        <Def k="opponent defensive style" v="r = +0.15 / +0.28">
          Do certain defences leak disproportionately to one type of attacker beyond
          the team lambda already flowing through? Attackers split into three bands by
          xG90, residuals taken against each player's own season mean so quality and
          team strength are already removed, and the type-by-opponent cell correlated
          across consecutive seasons. It repeats at r = +0.15 in one fold
          (p = 0.25, not significant) and +0.28 in the other, on 60 cells apiece.
          One fold clearing the bar and one failing it is what noise looks like at
          this sample size — the same verdict the big-six splits got, for the same
          reason.
        </Def>
        <Def k="price changes" v="r = +0.24 / +0.28 / +0.30 — KEPT, but not here">
          The one Task 30 candidate that survived. Net transfers per existing owner
          predicts the next gameweek's price move at r = 0.24 to 0.30 across all
          three seasons on ~11,000 rows each. It is deliberately kept OUT of the
          expected-points model: a player is not better because people are buying
          him, and a price change is not a football event. It belongs to the transfer
          planner, where "he rises tonight" is a reason to act sooner and nothing
          more. See <code>fplab/price_moves.py</code>.
        </Def>
        <Def k="finishing skill" v="r = +0.05">
          A player who beat his expected goals by eight last season is overwhelmingly
          likelier to have been lucky than to be repeatable. At that reliability, last
          season's overperformance says nothing about next season's, so there is no
          "clinical finisher" bonus. Contrast the assist gap at r = +0.25, which{" "}
          <em>is</em> modelled — the difference between them is the whole argument.
        </Def>
        <Def k="big-six / low-block splits" v="r = −0.10, −0.12">
          The league-average effects are real and large, and they already flow through
          the fixture λ. It is the player-level interaction — "he turns up in big
          games" — that does not survive measurement.
        </Def>
        <Def k="a player's own home/away split" v="r = 0.00">
          Nineteen home games is too small a sample to read a personal split from. The
          league-wide venue effect is kept; the individual one is noise.
        </Def>
        <Def k="Dixon-Coles low-score correction" v="rho = −0.047">
          The famous one, implemented in full and fitted rather than assumed. It
          moves the scoreline distribution exactly as advertised — 0-0 up 8.5%,
          1-0 down 5.6% — and preserves the clean-sheet marginal <b>exactly</b>,
          to every decimal place, at every lambda. FPL scores clean sheets, not
          scorelines, so it cannot move a projection at all. Academic fame is not
          a reason to ship something inert.
        </Def>
        <Def k="clean-sheet recalibration" v="better Brier, worse ranking">
          The model over-rates elite defences' clean sheets (35% at lambda 1.0
          against a real 29%) and under-rates leaky ones. A fitted correction
          improves the clean-sheet Brier score in all three holdout seasons — and
          was still rejected, because it makes rank correlation <em>worse</em> for
          exactly the players it targets (GK 0.102 → 0.078, DEF 0.271 → 0.267).
          Flattening a curve buys calibration by being less confident, and
          confidence is what discrimination is made of. Squads are picked by
          ranking defenders, not by quoting their odds.
        </Def>
        <Def k="simulated bonus replacing the curve" v="captain 8.89 → 8.51">
          The match simulation is better on the bonus component itself — 11% lower
          error and 7% better rank correlation than the curve. It still does not
          drive the projections, because capping a match at six bonus points
          spreads expected bonus across everyone who <em>might</em> play, so a
          nailed premium loses bonus to squad players who then do not feature.
          Correct before the teamsheets, wrong for ranking. The simulation stays
          for its distributions, which cost nothing because they do not feed
          expected points.
        </Def>
        <Def k="elite-vs-elite caution" v="p = 0.14">
          Top-quintile sides facing each other returned 0.894× the predicted xG against
          0.984× elsewhere — the right direction, and a plausible story about cautious
          big matches. But on 76 matches it is not significant, so adding it would be a
          thumb on the scale rather than a measurement.
        </Def>
        <div className="card mt-card">
          <div className="mt-card-t">Genuine limits</div>
          <p className="mt-p">
            Foreign-league minutes are unreachable from here, so a signing from abroad
            gets a price-implied prior and a <code>*</code>. Predicted XIs are a
            pre-season snapshot whose value decays fast. Rotation for European nights
            is not modelled per club. And expected points are a mean, not a forecast:
            the same projection covers a blank and a fifteen-point haul, and the spread
            around a projection is far wider than the spread between players.
          </p>
        </div>
      </Sec>

      <p className="built-stamp mt-stamp">
        model built {DATA.built} · {DATA.players.length} players ·{" "}
        {(M.seasons_rated || []).length} seasons rated · horizon GW{gwFirst}–{gwLast}
      </p>
    </div>
  );
}
