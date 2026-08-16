"""
Ratings for promoted teams.

Coventry, Hull and Ipswich have no Premier League match history, so they have
no xG-derived attack/defence rating. v1 of the pipeline silently DROPPED every
fixture involving them — which quietly deleted ~30% of all GW1-6 fixtures and
made the projections wrong for the other 17 clubs too (their easiest fixtures
vanished).

Two things are handled here:

1. Promoted sides get a prior drawn from how promoted sides actually perform
   in the Premier League, not from their Championship numbers. Championship xG
   does not translate — a 2.1 xG/90 Championship attack is roughly a 1.1 xG/90
   Premier League attack.

2. Relegated sides are removed from the ratings table so their stale entries
   can't be matched against a fixture list they don't appear in.

The promoted prior
------------------
FITTED, not guessed — `python -m fplab.fit_promoted` measures every club that
came up in a season we can reach and computes its real attacking and defensive
strength against that season's league average:

    2023-24  BUR 0.68/1.17   LUT 0.74/1.36   SHU 0.65/1.29
    2024-25  IPS 0.64/1.37   LEI 0.60/1.35   SOU 0.61/1.59
    2025-26  BUR 0.61/1.43   LEE 1.01/1.04   SUN 0.72/1.02

    mean attacking strength  0.696  (sd 0.129)
    mean defensive weakness  1.290  (sd 0.186)

The previous hand-picked 0.82 / 1.22 was too kind on both counts: promoted
sides attack 15% worse than that and concede 6% more. This matters twice over,
because a promoted club is the one case where the model has no history at all —
the prior IS the projection for all 86 players at Coventry, Hull and Ipswich,
AND it sets how easy those clubs are to play against for the other 17.

The spread is real and large (Leeds came up and were league-average; Southampton
conceded 59% above average), which is exactly why this stays a prior: the
credibility shrinkage in ratings.team_ratings pulls each club toward its actual
2026/27 form as soon as real matches are played.

The venue split was measured too and the old hand-picked values held up almost
exactly (fitted att 1.104/0.896 vs assumed 1.10/0.90), so those are unchanged.

These are PRIORS. As soon as real 2026/27 matches are played, the credibility
shrinkage in ratings.team_ratings pulls each promoted team toward its actual
performance, and the prior's influence decays away.
"""
from __future__ import annotations

import pandas as pd

# Fitted over 9 promoted clubs, 2023-24 to 2025-26. See fplab/fit_promoted.py.
PROMOTED_ATT = 0.696
PROMOTED_DEF = 1.290

# Route of promotion carries real signal: play-off winners underperform
# automatic promotions in their first PL season.
ROUTE_ADJUST = {
    "champion": (1.04, 0.97),   # (att multiplier, def multiplier)
    "automatic": (1.00, 1.00),
    "playoff": (0.94, 1.05),
}

# 2026/27 promoted sides (real): Coventry champions, Ipswich runners-up,
# Hull via the play-off final.
PROMOTED_2026_27 = {
    "COV": "champion",
    "IPS": "automatic",
    "HUL": "playoff",
}


def promoted_rating(route: str = "automatic",
                    home_advantage: float = 1.12) -> dict[str, float]:
    """Build a full ratings row for a promoted side."""
    a_mult, d_mult = ROUTE_ADJUST.get(route, (1.0, 1.0))
    att = PROMOTED_ATT * a_mult
    dfw = PROMOTED_DEF * d_mult
    return {
        # Promoted teams are more home-dependent than established sides.
        "att_home": att * 1.10,
        "att_away": att * 0.90,
        "def_home": dfw * 0.93,
        "def_away": dfw * 1.07,
        "n_home": 0.0,
        "n_away": 0.0,
        "att": att,
        "def_": dfw,
    }


def reconcile(
    ratings: pd.DataFrame,
    current_teams: list[str],
    promoted: dict[str, str] | None = None,
) -> pd.DataFrame:
    """
    Align a ratings table (built from last season) with THIS season's 20 teams.

      * teams in both -> keep their real, earned rating
      * promoted (in current, not in ratings) -> promoted prior
      * relegated (in ratings, not in current) -> dropped

    Returns a ratings frame indexed by exactly `current_teams`, so no fixture
    can ever be silently dropped for a missing team again.
    """
    promoted = promoted or PROMOTED_2026_27
    out = ratings.copy()

    relegated = [t for t in out.index if t not in current_teams]
    if relegated:
        out = out.drop(index=relegated)

    # Every club named as promoted takes the promoted prior, whether or not the
    # ratings table happens to hold a row for it. The "missing teams only" test
    # this replaces was correct while ratings came from a single season, but
    # the log now spans three — so Ipswich, relegated in 2025 and back up in
    # 2026, arrives carrying real 2024/25 Premier League ratings. Those are a
    # year and a division stale, and treating them as current would rate a
    # promoted side off matches played before its promotion campaign.
    need_prior = [t for t in current_teams
                  if t in promoted or t not in out.index]
    for t in need_prior:
        route = promoted.get(t, "automatic")
        out.loc[t] = promoted_rating(route)

    out["is_promoted"] = [t in need_prior for t in out.index]
    return out.loc[current_teams]


def report(ratings: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in ["att", "def_", "is_promoted"] if c in ratings.columns]
    return ratings[cols].sort_values("att", ascending=False).round(3)
