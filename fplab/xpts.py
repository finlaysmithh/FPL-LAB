"""
The expected-points engine.

A player's blended per-90 rates describe what he does in an *average* fixture.
To project a *specific* fixture we convert his rate into a SHARE of his team's
output, then rescale that share by the fixture's expected goals:

    share_g   = xG90_player  / teamxG90
    xG_fix    = share_g * lambda_team * minutes_factor

This is the step that makes "weak opposition defence" flow through to the
player.  A striker on 0.55 xG/90 in a side averaging 1.5 xG/90 owns 37% of his
team's chances; away at a side whose DefWeak is 1.4, lambda rises to ~2.0 and
his fixture xG rises to ~0.73 — a 33% uplift purely from the opponent.

Total expected points:

    xP = P(60) * 2 + (P(play) - P(60)) * 1
       + xG_fix   * G_pos
       + xA_fix   * 3
       + CS_prob  * CS_pos * P(60)
       + P(defcon hit) * 2
       + xSaves / 3                     (GK)
       - E[floor(GC/2)] * P(60)         (GK/DEF)
       + xBonus
       - E[cards]

Each component carries a fitted multiplicative weight from calibrate.py, which
corrects systematic bias (e.g. raw xA consistently over-predicts assist points
because not every chance created is converted).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson

from .config import (
    ASSIST_POINTS,
    DEFCON_DISPERSION,
    CLEAN_SHEET_POINTS,
    DEFAULT_COMPONENT_WEIGHTS,
    DEFCON_POINTS,
    DEFCON_THRESHOLD,
    FPL_ASSIST_INFLATION,
    GOAL_POINTS,
    RED_CARD,
    SAVES_PER_POINT,
    YELLOW_CARD,
)
from .ratings import goals_conceded_penalty


def defcon_probability(defcon90: float, position: str, minutes_factor: float) -> float:
    """
    P(player reaches his DefCon threshold in a match he plays).

    Defensive actions are count data, but they are NOT Poisson: measured on
    2025/26, variance/mean is 1.88 for defenders, 2.12 for midfielders and 1.61
    for forwards. Poisson assumes 1.0, so it under-weights the tail — and the
    tail is the whole event, since DefCon pays only on crossing a threshold.

    A Negative Binomial with the same mean and a fitted dispersion `r`
    (variance = mu + mu^2/r) handles that. The error Poisson makes is heavily
    concentrated in low-rate players, which is exactly the burstiness pattern:

        rate band   real hit rate   Poisson says   ratio
        <4              0.003          0.001        3.7x
        4-6             0.033          0.024        1.4x
        6-8             0.142          0.114        1.2x
        8-10            0.307          0.291        1.1x
        10+             0.503          0.498        1.0x

    Worth stating honestly: most of the raw variance/mean ratio above is
    BETWEEN-player heterogeneity, not within-player burstiness. Once you
    condition on a player's own rate — which this function does — the residual
    overdispersion is milder, and NB buys roughly 8% on the mean hit rate
    rather than the 60% the pooled variance ratio might suggest. It is still
    the right distribution, and it is free.

    `minutes_factor` is minutes-given-he-plays, not the unconditional minutes
    share. Scaling the rate by an unconditional share and then multiplying the
    result by P(play) in `player_xp` discounts availability twice.
    """
    thr = DEFCON_THRESHOLD.get(position)
    if thr is None or defcon90 <= 0:
        return 0.0
    mu = float(defcon90) * float(minutes_factor)
    if mu <= 0:
        return 0.0
    r = DEFCON_DISPERSION.get(position, 35.0)
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(thr - 1, r, p))


def expected_bonus(bps90: float, minutes_factor: float, team_strength: float) -> float:
    """
    Expected bonus points from BPS rate.

    Bonus is a rank statistic within a match and a TAIL event: a player
    averaging 15 BPS earns his bonus in the games he hits 35, not in the
    average game.

    That distinction is the whole reason this function looks the way it does.
    An earlier version fitted (one match's BPS -> that match's bonus), which is
    steeply convex, and then evaluated it at the player's *mean* BPS. The mean
    of a convex function is not the function of the mean (Jensen's inequality),
    and the error was severe — 0.024 expected bonus per starter against a real
    0.294, twelve times too small, because every match above the mean, where
    all the bonus actually lives, was flattened away.

    So the curve below is fitted on the quantity we actually need: given a
    player's BPS PER 90, how much bonus does he average per appearance? Fitting
    on player-season aggregates integrates over each player's own spread, so the
    tail is inside the curve rather than discarded before it.

    Fitted by `python -m fplab.fit_bonus` on 315 players with 10+ starts in
    2025/26: mean 0.2924 against a real 0.2917, corr 0.77.

    `minutes_factor` scales the result, never the input — feeding minutes into
    the rate is what caused the original bug. A player who plays 65 minutes
    accrues less BPS than one who plays 90, so his bonus is scaled against the
    ~0.85-of-a-match the fitted population averaged.
    """
    p_any = 1.0 / (1.0 + np.exp(-(bps90 - 23.83) / 5.32))
    per_appearance = p_any * 1.607 * (0.85 + 0.15 * team_strength)
    mins_adj = float(np.clip(minutes_factor / 0.85, 0.35, 1.15))
    return float(per_appearance * mins_adj)


def expected_saves(saves90: float, lam_against: float, minutes_factor: float) -> float:
    """GK saves scale with how much the opposition attacks."""
    return saves90 * minutes_factor * (0.6 + 0.4 * (lam_against / 1.45))


def player_xp(
    player: pd.Series,
    fixture: pd.Series,
    team_xg90: float,
    weights: dict | None = None,
) -> dict:
    """
    Expected points for one player in one fixture.  Returns the total plus a
    full component breakdown so the UI can explain *why* a player is ranked
    where he is.
    """
    w = {**DEFAULT_COMPONENT_WEIGHTS, **(weights or {})}
    pos = player["position"]

    p_play = float(player.get("p_play", player["mins_share_blend"]))
    p_60 = float(player.get("p_60", p_play * 0.88))
    mf = float(player.get("mins_share_blend", p_play))  # minutes as fraction of 90

    lam_for = float(fixture["lam_for"])
    lam_against = float(fixture["lam_against"])
    cs_prob = float(fixture["cs_prob"])

    share_g = player["xg90_blend"] / team_xg90 if team_xg90 > 0 else 0.0
    share_a = player["xa90_blend"] / team_xg90 if team_xg90 > 0 else 0.0

    xg_fix = share_g * lam_for * mf
    xa_fix = share_a * lam_for * mf

    # Minutes GIVEN he plays. `mf` is the unconditional share, so it already
    # carries the chance he does not feature; feeding that into a rate and then
    # multiplying the result by p_play discounts availability twice. Components
    # that are then scaled by p_play must use this conditional figure instead.
    mf_given_play = float(np.clip(mf / p_play, 0.0, 1.0)) if p_play > 0.01 else 0.0

    appearance = p_60 * 2 + (p_play - p_60) * 1
    goals = xg_fix * GOAL_POINTS[pos]
    # xA counts passes that led to shots; FPL also pays for won penalties,
    # rebounds and deflections. `assist_mult` is the player's own inflation,
    # shrunk hard toward the positional constant (see blend.assist_multiplier);
    # the constant is the fallback for any caller that has not populated it.
    a_mult = player.get("assist_mult")
    if a_mult is None or not np.isfinite(a_mult) or a_mult <= 0:
        a_mult = FPL_ASSIST_INFLATION.get(pos, 1.33)
    assists = xa_fix * ASSIST_POINTS * float(a_mult)
    clean_sheet = cs_prob * CLEAN_SHEET_POINTS[pos] * p_60
    defcon = (defcon_probability(player["defcon90_blend"], pos, mf_given_play)
              * DEFCON_POINTS * p_play)
    bonus = expected_bonus(player["bps90_blend"], mf_given_play, lam_for / 1.45) * p_play

    saves = 0.0
    if pos == "GK":
        # Saves are per-90 for a keeper who plays; scale by minutes then by the
        # chance he is between the posts at all. A zero rate here means the
        # prior never populated it — real rates come from build_prior now.
        sv = float(player.get("saves90", 0.0) or 0.0)
        saves = (expected_saves(sv, lam_against, mf_given_play) / SAVES_PER_POINT) * p_play

    conceded = 0.0
    if pos in ("GK", "DEF"):
        conceded = -goals_conceded_penalty(lam_against) * p_60

    # Real per-90 card rates, not a dead 0.12 default that was never populated.
    # Reds are rare but cost three times as much, so both are carried.
    yellow = float(player.get("yellow90", 0.0) or 0.0)
    red = float(player.get("red90", 0.0) or 0.0)
    cards = (yellow * YELLOW_CARD + red * RED_CARD) * mf_given_play * p_play

    total = (
        w["appearance"] * appearance
        + w["goals"] * goals
        + w["assists"] * assists
        + w["clean_sheet"] * clean_sheet
        + w["defcon"] * defcon
        + w["bonus"] * bonus
        + w["saves"] * saves
        + w["conceded"] * conceded
        + w["cards"] * cards
    )

    return {
        "xp": float(total),
        "xp_appearance": appearance,
        "xp_goals": goals,
        "xp_assists": assists,
        "xp_cs": clean_sheet,
        "xp_defcon": defcon,
        "xp_bonus": bonus,
        "xp_saves": saves,
        "xp_conceded": conceded,
        "xp_cards": cards,
        "xg_fix": xg_fix,
        "xa_fix": xa_fix,
    }


MINUTES_COLS = ("p_play", "p_60", "mins_share_blend", "p_start")


def project(
    players: pd.DataFrame,
    fixture_table: pd.DataFrame,
    team_xg90: dict[str, float],
    gws: list[int],
    weights: dict | None = None,
    minutes_by_gw: dict[int, pd.DataFrame] | None = None,
) -> pd.DataFrame:
    """
    Project every player across every requested gameweek.

    Handles blanks (no fixture -> 0 points) and doubles (two fixtures -> sum),
    which is essential for any horizon or wildcard planning.

    `minutes_by_gw` supplies per-gameweek minutes — a frame per gameweek,
    indexed like `players`, carrying p_play / p_60 / mins_share_blend. It is
    how injury reallocation reaches the projection: when a club loses two
    centre-halves in GW3, the players behind them hold different minutes in
    GW3 than they do in GW9, and a single static estimate per player cannot
    express that. Without it the player's own columns are used for every week,
    which is the old behaviour.

    Returns long format: one row per (player, gw).
    """
    rows = []
    for _, p in players.iterrows():
        pid = p["fpl_id"] if "fpl_id" in p else p["id"]
        fixs = fixture_table[fixture_table["team"] == p["team"]]
        for gw in gws:
            gwf = fixs[fixs["gw"] == gw]
            if gwf.empty:                       # blank gameweek
                rows.append({"fpl_id": pid, "gw": gw, "xp": 0.0, "n_fix": 0})
                continue
            pg = p
            wk = (minutes_by_gw or {}).get(gw)
            if wk is not None and p.name in wk.index:
                pg = p.copy()
                for c in MINUTES_COLS:
                    if c in wk.columns:
                        pg[c] = wk.at[p.name, c]
            agg = {"fpl_id": pid, "gw": gw, "n_fix": len(gwf)}
            tot = None
            for _, f in gwf.iterrows():         # double gameweek: sum fixtures
                comp = player_xp(pg, f, team_xg90.get(p["team"], 1.45), weights)
                tot = comp if tot is None else {k: tot[k] + comp[k] for k in tot}
            agg.update(tot)
            agg["opponent"] = ", ".join(gwf["opponent"])
            agg["fdr_attack"] = float(gwf["fdr_attack"].mean())
            agg["fdr_defence"] = float(gwf["fdr_defence"].mean())
            # xP ASSUMING HE STARTS. The headline projection multiplies quality
            # by the chance of playing, which is correct but conflates two very
            # different reasons for a low number: a poor player, and a good
            # player the model is unsure about. A manager who already knows the
            # team news can read past the second. Same engine, same fixture,
            # minutes forced to a full start.
            ps = pg.copy()
            ps["p_60"] = 1.0
            ps["p_play"] = 1.0
            ps["mins_share_blend"] = min(1.0, float(
                pg.get("mins_per_start_prior", 85.0) or 85.0) / 90.0)
            st = None
            for _, f in gwf.iterrows():
                c = player_xp(ps, f, team_xg90.get(p["team"], 1.45), weights)
                st = c if st is None else {k: st[k] + c[k] for k in st}
            agg["xp_start"] = st["xp"] if st else 0.0
            agg["exp_mins_gw"] = float(pg.get("mins_share_blend", 0.0)) * 90.0
            agg["p_start_gw"] = float(pg.get("p_start", pg.get("p_play", 0.0)))
            agg["p60_gw"] = float(pg.get("p_60", 0.0))
            # P(any appearance), which is NOT p_start: a substitute who comes on
            # for ten minutes scores an appearance point and, more importantly,
            # blocks the autosub that would otherwise replace a starter who
            # played nothing. The XI selector needs this distinction, so it
            # reads the minutes model's own number rather than re-deriving one.
            agg["p_play_gw"] = float(pg.get("p_play", pg.get("p_start", 0.0)))
            rows.append(agg)

    proj = pd.DataFrame(rows)
    id_col = "fpl_id" if "fpl_id" in players.columns else "id"
    keep = [id_col, "display_name", "team", "position", "price", "provisional"]
    for extra in ("ownership", "is_pen_taker", "pen_order", "web_name",
                  "exp_mins", "minutes_flag", "minutes_ceiling", "mins_share_raw",
                  "status", "chance_playing"):
        if extra in players.columns:
            keep.append(extra)
    meta = players[keep].rename(columns={id_col: "fpl_id"})
    if "ownership" not in meta.columns:
        meta["ownership"] = 0.0
    return proj.merge(meta, on="fpl_id", how="left")
