"""
Joint match simulation: zero-sum bonus, and the shape of a projection.

Two things the analytic engine cannot produce, both of which matter for real
FPL decisions.

**Bonus is a contest, not a rate.** The shipped model maps a player's BPS per
90 to an average bonus per appearance. That is well calibrated in aggregate —
0.298 predicted against 0.294 real per starter — but it is blind to the one
thing bonus actually depends on: who else is on the pitch. Exactly three bonus
points are awarded in every match regardless of how well anyone plays, so a
defender in a 0-0 between two dour sides collects the same 3 points as a
hat-trick scorer, and a good player in a match full of good players collects
nothing. A rate model cannot express that, because it never looks at the
opponent.

**A projection has a shape.** 6.5 expected points from a midfielder and 6.5
from a defender are not the same FPL decision: one is a wide distribution with
a real chance of 15+, the other is a narrow one that mostly returns 2 or 6.
Captaincy is a bet on the ceiling, not the mean, and the mean alone cannot rank
captains.

Both fall out of the same simulation, which is why they are one module.

METHOD
------
For each fixture, both starting elevens are simulated together, N times:

    goals      Poisson on the player's fixture xG
    assists    Poisson on the player's fixture xA
    clean sheet   ONE Bernoulli per team per simulation, shared by all eleven
                  of its players — this is the correlation the analytic model
                  throws away, and it is what makes a defensive stack a real
                  concentration of risk rather than eleven independent bets
    defcon     Negative Binomial on the player's own rate, as elsewhere
    minutes    Bernoulli on P(60), then P(play), so an unused substitute
               scores nothing in that simulation
    BPS        rebuilt from the simulated events
    bonus      the 22 simulated BPS values are RANKED and 3/2/1 awarded under
               FPL's real rules, ties included

The whole thing is vectorised over (players x simulations) with NumPy — no
Python loop over simulations — so the full 380-fixture season runs in seconds.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import (ASSIST_POINTS, CLEAN_SHEET_POINTS, DEFCON_DISPERSION,
                     DEFCON_POINTS, DEFCON_THRESHOLD, GOAL_POINTS)

N_SIMS = 2000
RNG_SEED = 20260813

# BPS earned per event, from FPL's published table. Only the terms the engine
# can actually project are modelled; the rest live in the baseline below.
BPS_GOAL = {"GK": 12, "DEF": 12, "MID": 18, "FWD": 24}
BPS_ASSIST = 9
BPS_CLEAN_SHEET = {"GK": 12, "DEF": 12, "MID": 0, "FWD": 0}
BPS_PLAY_60 = 6
BPS_PLAY = 3


def _nb_draw(rng, mean, disp, size):
    """Negative Binomial draws with the given mean and dispersion r."""
    mean = np.clip(mean, 1e-6, None)
    p = disp / (disp + mean)
    return rng.negative_binomial(disp, p, size=size)


def simulate_fixture(players: pd.DataFrame, n_sims: int = N_SIMS,
                     rng: np.random.Generator | None = None,
                     return_draws: bool = False) -> dict:
    """
    Simulate one match's worth of players.

    `players` needs one row per player in the fixture with: position, team,
    p_60, p_play, xg_fix, xa_fix, cs_prob, defcon90, mins_share, bps_base.

    Returns arrays indexed like `players`: expected bonus, the bonus
    distribution, expected points and its percentiles.
    """
    rng = rng or np.random.default_rng(RNG_SEED)
    n = len(players)
    if n == 0:
        return {}
    S = n_sims

    pos = players["position"].to_numpy()
    team = players["team"].to_numpy()
    p60 = players["p_60"].to_numpy(float)[:, None]
    pplay = np.maximum(players["p_play"].to_numpy(float)[:, None], p60)

    # --- minutes -----------------------------------------------------------
    u = rng.random((n, S))
    played60 = u < p60
    played = u < pplay

    # --- clean sheets: ONE draw per team, shared by its players -------------
    teams = pd.unique(team)
    cs_by_team = {}
    for t in teams:
        p = float(players.loc[players["team"] == t, "cs_prob"].iloc[0])
        cs_by_team[t] = rng.random(S) < p
    cs = np.vstack([cs_by_team[t] for t in team]) & played60

    # --- attacking returns --------------------------------------------------
    goals = rng.poisson(np.clip(players["xg_fix"].to_numpy(float), 0, None)[:, None]
                        * np.ones((1, S))) * played
    assists = rng.poisson(np.clip(players["xa_fix"].to_numpy(float), 0, None)[:, None]
                          * np.ones((1, S))) * played

    # --- defensive contribution --------------------------------------------
    dc_hit = np.zeros((n, S), dtype=bool)
    rate = players["defcon90"].to_numpy(float) * players["mins_share"].to_numpy(float)
    for i in range(n):
        thr = DEFCON_THRESHOLD.get(pos[i])
        if not thr:
            continue
        disp = DEFCON_DISPERSION.get(pos[i], 30.0)
        dc_hit[i] = _nb_draw(rng, rate[i], disp, S) >= thr
    dc_hit &= played

    # --- BPS ----------------------------------------------------------------
    gpts = np.array([BPS_GOAL.get(p, 18) for p in pos])[:, None]
    cpts = np.array([BPS_CLEAN_SHEET.get(p, 0) for p in pos])[:, None]
    bps = (players["bps_base"].to_numpy(float)[:, None] * played60
           + goals * gpts + assists * BPS_ASSIST + cs * cpts
           + played60 * BPS_PLAY_60 + (played & ~played60) * BPS_PLAY)
    # Only players who appeared can win bonus.
    bps = np.where(played, bps, -1.0)

    # --- bonus: rank the whole match, award 3/2/1 with ties -----------------
    bonus = np.zeros((n, S))
    if n > 1:
        order = np.argsort(-bps, axis=0)
        ranked = np.take_along_axis(bps, order, axis=0)
        # FPL awards 3 to the top score, 2 to the next distinct, 1 to the next.
        # Ties share the higher award and consume the slot below, which the
        # comparison against the top-three thresholds reproduces exactly.
        top1 = ranked[0]
        top2 = ranked[1] if n > 1 else np.full(S, -1.0)
        top3 = ranked[2] if n > 2 else np.full(S, -1.0)
        eligible = bps >= 0
        is1 = (bps >= top1) & eligible
        is2 = (bps >= top2) & (~is1) & eligible
        is3 = (bps >= top3) & (~is1) & (~is2) & eligible
        bonus = np.where(is1, 3.0, np.where(is2, 2.0, np.where(is3, 1.0, 0.0)))

    # --- FPL points ---------------------------------------------------------
    gp = np.array([GOAL_POINTS.get(p, 4) for p in pos])[:, None]
    cp = np.array([CLEAN_SHEET_POINTS.get(p, 0) for p in pos])[:, None]
    pts = (2.0 * played60 + 1.0 * (played & ~played60)
           + goals * gp + assists * ASSIST_POINTS + cs * cp
           + dc_hit * DEFCON_POINTS + bonus)

    q = np.percentile(pts, [10, 25, 50, 75, 90], axis=1)
    out_extra = {}
    if return_draws:
        # The raw (players x sims) matrix. Summaries are marginals and marginals
        # cannot answer a question about JOINT behaviour — two defenders sharing
        # a clean sheet look identical to two independent ones once you have
        # collapsed to means and percentiles. Anything measuring correlation, or
        # a whole squad's variance, has to see the draws.
        out_extra["points_draws"] = pts
    return {
        **out_extra,
        "e_bonus": bonus.mean(axis=1),
        "p_bonus3": (bonus == 3).mean(axis=1),
        "e_points": pts.mean(axis=1),
        "sd_points": pts.std(axis=1),
        "p10": q[0], "p25": q[1], "median": q[2], "p75": q[3], "p90": q[4],
        "p_2plus": (pts >= 2).mean(axis=1),
        "p_6plus": (pts >= 6).mean(axis=1),
        "p_10plus": (pts >= 10).mean(axis=1),
        "p_15plus": (pts >= 15).mean(axis=1),
    }


def simulate_gameweek(proj: pd.DataFrame, gw: int, n_sims: int = N_SIMS,
                      rng: np.random.Generator | None = None) -> pd.DataFrame:
    """Simulate every fixture in one gameweek. Returns one row per player."""
    rng = rng or np.random.default_rng(RNG_SEED + gw)
    wk = proj[proj["gw"] == gw]
    out = []
    for opp_pair, grp in wk.groupby("match_key"):
        # Only players with a real chance of featuring contest the bonus; a
        # 30-man registry per club would otherwise dilute the ranking with
        # players who are not in the match at all.
        g = grp[grp["p_play"] > 0.05].copy()
        if g.empty:
            continue
        res = simulate_fixture(g, n_sims=n_sims, rng=rng)
        if not res:
            continue
        r = pd.DataFrame(res, index=g.index)
        r["fpl_id"] = g["fpl_id"].values
        r["gw"] = gw
        out.append(r)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()
