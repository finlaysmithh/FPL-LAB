"""
Penalty modelling.

Why this matters: a first-choice penalty taker is worth roughly +0.10 xG per
match — about 8 points across a season for a midfielder, more for a forward.
Ignoring it (as v1 and v2 did) systematically undervalues players like Palmer,
Saka and Isak, and overvalues their non-taking teammates.

The double-counting trap
------------------------
FPL's `expected_goals` INCLUDES penalties. So a player who took pens last
season already has that xG baked into his prior rate. Naively adding a penalty
bonus on top would count it twice.

The fix is a two-step correction, which is only possible because we have real
`penalties_order` data for BOTH seasons:

    npxG90_prior = xG90_prior − penXG90_under_LAST_season's_order
    xG90_model   = npxG90_prior + penXG90_under_THIS_season's_order

This is what correctly handles the interesting cases:
  * Isak now takes Liverpool's penalties. His Newcastle prior gets stripped of
    whatever pen xG he had there, then re-credited at Liverpool's rate.
  * A player who LOST pen duty over the summer gets his prior correctly
    reduced — the model won't keep paying him for penalties he no longer takes.
  * Gyökeres is Arsenal's #2 behind Saka: he receives only the small share
    that flows to a second taker, not a full penalty premium.

The "not a given" rule
----------------------
If `penalties_order` is null for a player, he receives ZERO penalty xG. No
guessing, no splitting a team's penalties evenly across its forwards. An
unlisted player contributes nothing, which is the honest treatment — better to
under-credit than to invent a penalty taker.

Team penalty rate
-----------------
Penalties won correlate with how much a team attacks the box, so the team rate
is scaled by attacking strength:

    pen_rate_team = LEAGUE_PEN_RATE × AttStr_team

shrunk toward the league average, because single-season penalty counts are
extremely noisy (the whole league missed only 15 in 2025/26).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# ~100 penalties per PL season / 380 matches / 2 teams per match.
LEAGUE_PEN_RATE = 0.13          # penalties won, per team, per match
PEN_CONVERSION = 0.79           # historical PL penalty conversion rate
PEN_XG = 0.79                   # xG value of a penalty (Opta standard)

# Share of a team's penalties taken by each listed order, CONDITIONAL on the
# player being on the pitch. Order 1 does not take 100% — he is sometimes
# subbed, sometimes defers, occasionally injured mid-match.
ORDER_SHARE = {1: 0.84, 2: 0.12, 3: 0.03, 4: 0.01}

# Attacking-strength scaling is dampened: a team twice as good does not win
# twice as many penalties.
ATT_SCALING_EXPONENT = 0.6


def team_pen_rate(att_strength: float, league_rate: float = LEAGUE_PEN_RATE) -> float:
    """
    Expected penalties won per match for a team of given attacking strength
    (1.0 = league average).
    """
    return float(league_rate * (max(att_strength, 0.2) ** ATT_SCALING_EXPONENT))


def taker_share(order: float | None) -> float:
    """
    Fraction of the team's penalties this player takes.

    Returns 0.0 for an unlisted player — the "not a given, so nothing" rule.
    """
    if order is None or pd.isna(order):
        return 0.0
    try:
        o = int(order)
    except (TypeError, ValueError):
        return 0.0
    return ORDER_SHARE.get(o, 0.0)


def pen_xg90(order: float | None, att_strength: float) -> float:
    """
    Expected penalty xG per 90 for a player.

    NOTE: this is a per-90 rate, i.e. conditional on being ON THE PITCH.
    It must NOT be scaled by minutes here — xpts.py already multiplies every
    per-90 rate by the player's expected minutes fraction, and applying a
    minutes term in both places would halve every taker's penalty value.
    (v1 of this module did exactly that and showed Isak at 0.031 instead of
    0.086 xG/90 — roughly 2 penalties a season instead of 4.)
    """
    share = taker_share(order)
    if share <= 0:
        return 0.0
    return float(team_pen_rate(att_strength) * share * PEN_XG)


def correct_prior_for_penalties(
    players: pd.DataFrame,
    att_by_team: dict[str, float],
    prior_order_col: str = "penalties_order_prior",
    cur_order_col: str = "penalties_order",
    prior_team_col: str = "prior_team",
    cur_team_col: str = "team",
    xg_col: str = "xg90_prior",
) -> pd.DataFrame:
    """
    Strip last season's penalty xG out of the prior rate, then add this
    season's penalty xG based on current taker order.

    Adds columns:
        pen_xg90_prior     what we removed (their pen xG last season)
        npxg90_prior       non-penalty prior rate (the durable skill signal)
        pen_xg90_now       what we added (their pen xG under current order)
        xg90_prior         corrected: npxg90_prior + pen_xg90_now
        is_pen_taker       bool, listed with an order this season
        pen_order          the current order, or NaN
    """
    df = players.copy()
    league_avg_att = 1.0

    prior_orders = df[prior_order_col] if prior_order_col in df.columns else pd.Series(
        np.nan, index=df.index)
    cur_orders = df[cur_order_col] if cur_order_col in df.columns else pd.Series(
        np.nan, index=df.index)

    pen_prior, pen_now = [], []
    for i, row in df.iterrows():
        # Prior: use the club they actually played for last season where known.
        prior_team = row.get(prior_team_col)
        att_prior = att_by_team.get(prior_team, league_avg_att) if isinstance(
            prior_team, str) else league_avg_att
        att_cur = att_by_team.get(row.get(cur_team_col), league_avg_att)

        # Per-90 rates are conditional on being on the pitch, so no minutes
        # term here — xpts applies expected minutes downstream.
        pen_prior.append(pen_xg90(prior_orders.get(i), att_prior))
        pen_now.append(pen_xg90(cur_orders.get(i), att_cur))

    df["pen_xg90_prior"] = pen_prior
    df["pen_xg90_now"] = pen_now
    df["npxg90_prior"] = (df[xg_col].fillna(0.0) - df["pen_xg90_prior"]).clip(lower=0.0)
    df[xg_col] = df["npxg90_prior"] + df["pen_xg90_now"]
    df["pen_order"] = cur_orders
    df["is_pen_taker"] = cur_orders.notna()
    return df


def penalty_report(df: pd.DataFrame, teams: list[str] | None = None) -> pd.DataFrame:
    """Who takes penalties, and what it's worth to their projection."""
    t = df[df["is_pen_taker"]].copy()
    if teams:
        t = t[t["team"].isin(teams)]
    t["pen_pts_per_38"] = t["pen_xg90_now"] * 38 * t["position"].map(
        {"GK": 6, "DEF": 6, "MID": 5, "FWD": 4}).fillna(4)
    cols = ["web_name", "team", "position", "price", "pen_order",
            "pen_xg90_now", "npxg90_prior", "xg90_prior", "pen_pts_per_38"]
    cols = [c for c in cols if c in t.columns]
    return t.sort_values(["team", "pen_order"])[cols].round(3)
