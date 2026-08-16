"""
Team strength ratings and the fixture model.

The core object is a per-team pair of ratings:

    AttStr_t   attacking strength  = xGF90_t / league_avg
    DefWeak_t  defensive weakness  = xGA90_t / league_avg

separately estimated for home and away, then combined with an explicit
home-advantage term.  A team with DefWeak = 1.4 concedes 40% more expected
goals than the league average — that is the "how weak is their defence"
signal, and it is the dominant term when rating an *opponent's* attackers.

Expected goals in a fixture (the standard bivariate-Poisson attack/defence
decomposition, Dixon & Coles 1997):

    lambda_home = mu * AttStr_home * DefWeak_away * H
    lambda_away = mu * AttStr_away * DefWeak_home / H

Clean sheet probability is then P(opponent scores 0) = exp(-lambda_opp).

This produces TWO difficulty numbers per fixture — attacking difficulty and
defensive difficulty.  The official FPL FDR collapses both into one integer,
which is its single biggest flaw: a game against a leaky, high-scoring side is
easy for your forwards and hard for your defenders at the same time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import HOME_ADVANTAGE, TEAM_FORM_HALFLIFE, TEAM_FORM_WINDOW


def _decay_weights(n: int, halflife: float) -> np.ndarray:
    """Exponential recency weights, most recent match last."""
    if n == 0:
        return np.array([])
    age = np.arange(n - 1, -1, -1, dtype=float)
    return 0.5 ** (age / halflife)


def team_ratings(
    match_log: pd.DataFrame,
    halflife: float = TEAM_FORM_HALFLIFE,
    window: int = TEAM_FORM_WINDOW,
    prior_ratings: pd.DataFrame | None = None,
    prior_weight: float = 6.0,
) -> pd.DataFrame:
    """
    Compute attack/defence ratings from a team-match log.

    match_log columns:
        team, opponent, was_home (bool), xg_for, xg_against, kickoff (sortable)

    prior_ratings: last season's output, used to shrink early-season noise.
    prior_weight: equivalent number of matches of belief in the prior.

    Returns a frame indexed by team with columns:
        att_home, att_away, def_home, def_away, att, def_ (overall)
    """
    log = match_log.sort_values("kickoff").copy()
    league_mu = log["xg_for"].mean()

    rows = []
    for team, g in log.groupby("team"):
        g = g.tail(window)
        rec = {"team": team}
        for venue, is_home in (("home", True), ("away", False)):
            sub = g[g["was_home"] == is_home]
            w = _decay_weights(len(sub), halflife)
            if len(sub) == 0:
                xgf = xga = league_mu
                n_eff = 0.0
            else:
                xgf = float(np.average(sub["xg_for"], weights=w))
                xga = float(np.average(sub["xg_against"], weights=w))
                n_eff = float(w.sum())

            # Shrink toward the prior (or toward league average if none).
            if prior_ratings is not None and team in prior_ratings.index:
                p_att = float(prior_ratings.loc[team, f"att_{venue}"])
                p_def = float(prior_ratings.loc[team, f"def_{venue}"])
            else:
                p_att = p_def = 1.0

            k = n_eff / (n_eff + prior_weight)
            rec[f"att_{venue}"] = k * (xgf / league_mu) + (1 - k) * p_att
            rec[f"def_{venue}"] = k * (xga / league_mu) + (1 - k) * p_def
            rec[f"n_{venue}"] = n_eff
        rows.append(rec)

    out = pd.DataFrame(rows).set_index("team")
    out["att"] = (out["att_home"] + out["att_away"]) / 2
    out["def_"] = (out["def_home"] + out["def_away"]) / 2
    return _shrink_venue_splits(out)


# A club plays only 19 home and 19 away league games, so its measured venue
# split is a tiny sample. Measured across 34 real club-season pairs
# (2023-24 → 2025-26), the year-over-year correlation of a club's home/away
# attack split is r = 0.075 — essentially zero. Last season's split does not
# predict this season's, so it is noise, not a trait.
#
# Left untouched it does real damage: it had Newcastle at 1.42x stronger at
# home and Man City *better away* (0.89), which pushed Man Utd's away fixtures
# down the difficulty table and left a trip to the leakiest defence in the
# league ranked behind three home ties.
#
# So keep the league-wide venue effect (which is real and stable — home sides
# create ~11% more) and shrink each club's personal deviation from it almost
# all the way out. The weight is the measured reliability, floored at a little
# above zero so a genuinely extreme fortress still registers faintly.
VENUE_CREDIBILITY = 0.10


def _shrink_venue_splits(out: pd.DataFrame, w: float = VENUE_CREDIBILITY) -> pd.DataFrame:
    for side, base in (("att", "att"), ("def", "def_")):
        h, a = f"{side}_home", f"{side}_away"
        if h not in out.columns or a not in out.columns:
            continue
        overall = out[base].replace(0, np.nan)
        # League-average venue multiplier, e.g. att_home / att ≈ 1.06.
        lg_h = float((out[h] / overall).mean())
        lg_a = float((out[a] / overall).mean())
        own_h, own_a = out[h] / overall, out[a] / overall
        out[h] = overall * (w * own_h + (1 - w) * lg_h)
        out[a] = overall * (w * own_a + (1 - w) * lg_a)
    return out


# Exponent applied to both attack and defence ratings before they are
# multiplied into a fixture lambda.
#
# The plain Dixon-Coles product is systematically mis-scaled at the extremes.
# Measured over 2,280 team-matches (2023-24 → 2025-26), actual xG divided by
# predicted xG, banded by the strength of the opponent's defence:
#
#     opponent defence   strongest    2      3      4    weakest
#     actual / predicted   0.933    0.994  1.022  0.975  1.015
#
# The model over-predicts what a team creates against the best defences by
# about 7% and under-predicts against the worst. The same pattern shows up more
# starkly in the corner that matters most to a Fantasy manager: a top-quintile
# attack facing a bottom-quintile defence returned 1.156 times the predicted
# xG. That is exactly the "shouldn't a big team hammer a promoted side harder
# than this?" objection, and it turns out to be right and measurable rather
# than a matter of taste.
#
# The cause is shrinkage. `team_ratings` deliberately pulls each club toward
# the league average to control noise, and the ratings that come out therefore
# understate the true spread. Raising both ratings to a common power restores
# it without touching the ordering, and the lambdas are renormalised afterwards
# so the league's total expected goals is unchanged — this redistributes
# difficulty, it does not inflate it.
#
# 1.10 is the in-sample optimum: it cuts the spread across defence quintiles
# from 0.090 to 0.065. Held out by season, fitting on two and testing on the
# third, it improved 2023-24 (0.184 → 0.175) and 2024-25 (0.129 → 0.107) and
# made 2025-26 worse (0.105 → 0.150). Two out of three with a consistent fitted
# value across folds (1.07, 1.14, 1.20) is real but not overwhelming evidence,
# which is why the shipped exponent is the modest end of that range and not the
# 1.33-1.37 an unconstrained log-linear regression asks for. Those larger
# values overshoot: they flip the quintile bias to the other sign rather than
# removing it.
RATING_EXPONENT = 1.10


def fixture_lambdas(
    fixtures: pd.DataFrame,
    ratings: pd.DataFrame,
    league_mu: float,
    home_adv: float = HOME_ADVANTAGE,
    exponent: float = RATING_EXPONENT,
) -> pd.DataFrame:
    """
    Attach expected goals to each fixture.

    fixtures columns: gw, home, away
    Returns one row per TEAM per fixture (so 2 rows per match) with:
        gw, team, opponent, was_home, lam_for, lam_against, cs_prob,
        fdr_attack, fdr_defence
    """
    p = float(exponent)
    recs = []
    for _, f in fixtures.iterrows():
        h, a = f["home"], f["away"]
        if h not in ratings.index or a not in ratings.index:
            continue
        lam_h = (league_mu * ratings.at[h, "att_home"] ** p
                 * ratings.at[a, "def_away"] ** p * home_adv)
        lam_a = (league_mu * ratings.at[a, "att_away"] ** p
                 * ratings.at[h, "def_home"] ** p / home_adv)
        for team, opp, home, lf, la in (
            (h, a, True, lam_h, lam_a),
            (a, h, False, lam_a, lam_h),
        ):
            recs.append(
                {
                    "gw": f["gw"],
                    "team": team,
                    "opponent": opp,
                    "was_home": home,
                    "lam_for": lf,
                    "lam_against": la,
                    "cs_prob": float(clean_sheet_prob(la)),
                }
            )
    out = pd.DataFrame(recs)
    if out.empty:
        return out

    # Renormalise so the exponent redistributes difficulty without inflating
    # the league's total expected goals. Without this, raising ratings that
    # average near 1.0 to a power above 1 quietly shifts every projection in
    # the game, and the clean sheet and goals-conceded terms would drift with
    # it. `lam_against` is rebuilt from the same scaling so a fixture's two
    # halves stay consistent with each other.
    if len(out) and out["lam_for"].mean() > 0:
        scale = league_mu / float(out["lam_for"].mean())
        out["lam_for"] *= scale
        out["lam_against"] *= scale
        out["cs_prob"] = clean_sheet_prob(out["lam_against"])

    # Rescale to a friendly 1-10 difficulty scale (10 = hardest).
    out["fdr_attack"] = _to_scale(-out["lam_for"])
    out["fdr_defence"] = _to_scale(out["lam_against"])
    out["fdr_combined"] = (out["fdr_attack"] + out["fdr_defence"]) / 2
    return out


# How many standard deviations from the average fixture count as the ends of
# the scale. At 1.75 the extremes are reached by genuinely extreme fixtures —
# roughly the hardest and easiest 4% of the calendar — rather than by whichever
# single pair happens to bracket the season.
FDR_SPAN_SIGMA = 1.75


def _to_scale(x: pd.Series, lo: float = 1.0, hi: float = 10.0,
              span: float = FDR_SPAN_SIGMA) -> pd.Series:
    """Difficulty on a 1-10 scale, anchored on spread rather than on extremes.

    Min-max was the obvious choice and the wrong one. Expected goals in a
    fixture are tightly packed and right-skewed — the middle half of the 760
    fixtures in a season sits inside 0.41 of a goal, while the top end runs a
    full goal clear — so rescaling between the two extremes squashed nearly
    every ordinary fixture into a two-point band. Half the calendar came out
    between 5.1 and 7.1, which is why so much of it read as "hard" and why the
    colours stopped distinguishing anything. A rating that calls almost
    everything the same thing is not a rating.

    The skew also broke symmetry between the two columns. Because attacking
    difficulty is built from the negated lambda and defensive difficulty from
    the plain one, the same skew pulled their midpoints apart: the average
    attacking fixture scored 6.07 and the average defensive one 4.93. "Average"
    meant two different numbers depending on which column you were reading.

    Anchoring on ±`span` standard deviations fixes both at once. 5.5 is the
    average fixture by construction, in both columns; the ends belong to
    genuinely extreme games; and a season with no extremes correctly stays near
    the middle instead of being stretched to fill a scale it has not earned.
    """
    sd = float(x.std(ddof=0))
    mid = (lo + hi) / 2
    if sd == 0:
        return pd.Series(np.full(len(x), mid), index=x.index)
    z = ((x - float(x.mean())) / sd).clip(-span, span)
    return mid + z * (hi - lo) / (2 * span)


# Clean-sheet recalibration:  P(CS) = exp(-A * lam ** K)  instead of exp(-lam).
#
# The plain Poisson survival term is badly miscalibrated at both ends of the
# range, and in the direction that costs FPL managers the most money. Measured
# on 2,280 team-matches with real scorelines:
#
#     predicted lam    Poisson P(0)    actual clean-sheet rate
#          1.0             0.353                0.288
#          1.5             0.238                0.229
#          2.0             0.147                0.178
#          2.5             0.085                0.099
#
# The model is far too confident about elite defences and too pessimistic about
# leaky ones. That is the single most expensive error a defender projection can
# make: it is what makes a model insist on tripling up on the best team's
# back line at 55% clean-sheet odds when the real figure is nearer 40%.
#
# The cause is NOT the lambdas — mean lambda is within 1.0% of mean real goals
# conceded — and NOT overdispersion, which is mild (variance 1.541 against mean
# 1.494, near-Poisson). It is that a fixture's true lambda is uncertain, and
# squashing that uncertainty into a point estimate before exponentiating
# exaggerates both tails.
#
# SHIPPED AT 1.0 / 1.0 — i.e. the correction is OFF, and this is the record of
# why, because the temptation to switch it on again will recur.
#
# Fitted by maximum likelihood (A = 1.2089, K = 0.5637) the correction improves
# the clean-sheet BRIER SCORE in all three holdout seasons: 0.16192 -> 0.15976,
# 0.17665 -> 0.17531, 0.19340 -> 0.19127, with stable parameters across folds.
# On the isolated question "how well calibrated is this probability", it wins
# outright.
#
# It was still rejected, because on the question that decides FPL outcomes it
# loses. Run through the full engine and split by position, the correction
# makes RANK CORRELATION worse for exactly the players it targets:
#
#     rho          2024-25            2025-26
#     GK      0.0815 -> 0.0714    0.1019 -> 0.0779
#     DEF     0.2758 -> 0.2699    0.2711 -> 0.2665
#
# and it moves overall points calibration further from 1.0 (DEF 0.821 -> 0.801)
# rather than closer.
#
# The tension is real and worth understanding: flattening the curve buys
# calibration by being less confident, and discrimination is exactly what
# confidence buys. A squad is picked by RANKING defenders, not by quoting their
# clean-sheet odds, so a change that sharpens the probability and blunts the
# ranking is a change that loses points.
#
# What remains true and unfixed: the model over-rates elite defences' clean
# sheets (Poisson says 35% at lambda 1.0 against a real 29%) and under-rates
# leaky ones (15% against a real 18%). That is a genuine bias. A flat
# recalibration is not the way to fix it — a fix has to sharpen the ordering,
# not soften it.
#
# Note what this is NOT: the Dixon-Coles low-score correction. That was
# implemented and tested first (see fplab/dixon_coles.py) and rejected for a
# different and more absolute reason — it preserves the clean-sheet marginal
# EXACTLY, to every decimal place, so it cannot move an FPL projection at all.
CS_CALIB_A = 1.0
CS_CALIB_K = 1.0


def clean_sheet_prob(lam_against):
    """Calibrated P(the opponent fails to score). See CS_CALIB_A."""
    lam = np.clip(np.asarray(lam_against, dtype=float), 1e-6, None)
    return np.clip(np.exp(-CS_CALIB_A * lam ** CS_CALIB_K), 0.0, 1.0)


def goals_conceded_penalty(lam_against: float) -> float:
    """
    Expected FPL deduction for a GK/DEF, i.e. E[floor(goals_conceded / 2)]
    under a Poisson with mean lam_against.  Computed exactly over a truncated
    support rather than approximated as lam/2 — the floor makes a real
    difference at low lambda (a 0.8-lambda fixture costs ~0.19, not 0.40).
    """
    from math import exp, factorial

    total = 0.0
    for k in range(0, 12):
        p = exp(-lam_against) * lam_against**k / factorial(k)
        total += p * (k // 2)
    return total
