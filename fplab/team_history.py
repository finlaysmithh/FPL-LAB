"""
Multi-season team match log.

One season of expected goals is not enough evidence to rate a defence, and the
model was using exactly one. The consequence was visible in the fixture
colours: Liverpool came out at def_ = 0.999 — dead league average — so a home
game against Liverpool was rated a *green* fixture, and three of the calendar's
"easiest" attacking fixtures were trips to face them.

That is not a colour-scale problem. It is the ratings being asked to carry more
weight than 38 matches of xG can bear. The three-season picture is unambiguous:

    Liverpool xGA vs league average    2023-24  0.769
                                       2024-25  0.700
                                       2025-26  0.902

A single-season reading of the third number treats an off year as the whole
truth. A decayed blend of all three lands near 0.82 and says what any observer
would: Liverpool concede meaningfully less than average, and playing them is
never an easy fixture. This is what the user's "reputation matters" objection is
really pointing at — not that reputation should override measurement, but that
one season is too short a measurement, and the fix is more data rather than a
thumb on the scale.

Decay is applied in matches, not seasons, by `ratings.team_ratings`, so a club
promoted last summer is rated on the 38 matches it has rather than being
credited with three seasons it did not play.

Why not bookmakers or squad value
---------------------------------
Both are better instruments than three seasons of xG and neither is reachable
offline here. Multi-season xG is the closest available proxy and it is honest
about what it is: a longer measurement, not a market.
"""
from __future__ import annotations

import pandas as pd

from .sources import DATA

# Newest last. Three seasons is a deliberate stopping point: squads turn over,
# and at a 30-match half-life a fourth season would enter at under 7% weight
# while adding four more clubs that no longer exist in this division.
SEASONS = ["2023-24", "2024-25", "2025-26"]


def _season_log(season: str) -> pd.DataFrame:
    """Team-level xG per match for one season, from cached vaastav data."""
    base = DATA / f"vaastav_{season}"
    gws = pd.read_csv(base / "gws" / "merged_gw.csv")
    teams = pd.read_csv(base / "teams.csv")

    from .build_prior import team_match_log
    log = team_match_log(gws, teams)
    log["season"] = season
    return log


def build(seasons: list[str] | None = None) -> pd.DataFrame:
    """
    Combined team match log across seasons, ordered oldest to newest.

    `kickoff` is an ordering key, not a real timestamp — it only has to sort
    correctly, because `ratings.team_ratings` decays on position within a
    club's own history. Offsetting each season keeps that ordering valid
    across the join.
    """
    seasons = seasons or SEASONS
    frames = []
    for i, s in enumerate(seasons):
        log = _season_log(s)
        log["kickoff"] = log["kickoff"] + i * 10_000
        frames.append(log)
    out = pd.concat(frames, ignore_index=True)
    return out.sort_values("kickoff").reset_index(drop=True)


def summary(log: pd.DataFrame) -> pd.DataFrame:
    """Per-club, per-season attack and defence relative to that season's mean."""
    rows = []
    for season, g in log.groupby("season"):
        mu = g["xg_for"].mean()
        agg = g.groupby("team").agg(att=("xg_for", "mean"),
                                    def_=("xg_against", "mean")) / mu
        agg["season"] = season
        rows.append(agg.reset_index())
    return pd.concat(rows, ignore_index=True).pivot(
        index="team", columns="season", values=["att", "def_"]).round(3)


if __name__ == "__main__":
    log = build()
    print(f"{len(log)} team-match rows, {log['team'].nunique()} clubs, "
          f"seasons {sorted(log['season'].unique())}")
    print()
    print(summary(log).to_string())
