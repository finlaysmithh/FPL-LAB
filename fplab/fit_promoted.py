"""Fit the promoted-side prior against what promoted sides actually do.

The priors in `promoted.py` (attack 0.82, defence 1.22) were hand-picked. This
measures them instead: for every season we can reach, find the clubs that were
not in the division the year before, and compute their real attacking and
defensive strength relative to that season's league average.

A promoted club is the one case where the model has no history at all, so the
prior IS the projection for the whole squad — 84 of 86 players at Coventry,
Hull and Ipswich currently run on it. Getting it wrong distorts not just their
own players but every fixture the other 17 clubs play against them.

Run:  python -m fplab.fit_promoted
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import build_prior

SEASONS = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]


def season_strengths(season: str) -> pd.DataFrame | None:
    """Per-team attack/defence relative to that season's league average."""
    try:
        d = build_prior.fetch_season(season, require_gws=True)
    except Exception as e:
        print(f"  {season}: unavailable ({type(e).__name__})")
        return None
    gws, teams = d["gws"], d["teams"]
    if "expected_goals" not in gws.columns or gws["expected_goals"].isna().all():
        print(f"  {season}: no expected_goals column — skipped")
        return None
    try:
        ml = build_prior.team_match_log(gws, teams)
    except Exception as e:
        print(f"  {season}: match log failed ({e})")
        return None

    g = ml.groupby("team").agg(
        xgf=("xg_for", "mean"), xga=("xg_against", "mean"), n=("xg_for", "size"))
    g = g[g.n >= 20]
    if g.empty:
        return None
    g["att"] = g.xgf / g.xgf.mean()
    g["def_"] = g.xga / g.xga.mean()
    # Split by venue too — promoted sides are often respectable at home and
    # dreadful away, and a single number hides that.
    hm = ml[ml.was_home].groupby("team").agg(xgf_h=("xg_for","mean"), xga_h=("xg_against","mean"))
    aw = ml[~ml.was_home].groupby("team").agg(xgf_a=("xg_for","mean"), xga_a=("xg_against","mean"))
    g = g.join(hm).join(aw)
    g["att_home"] = g.xgf_h / g.xgf.mean()
    g["att_away"] = g.xgf_a / g.xgf.mean()
    g["def_home"] = g.xga_h / g.xga.mean()
    g["def_away"] = g.xga_a / g.xga.mean()
    g["season"] = season
    return g


def fit() -> dict:
    per_season, prev_teams = {}, None
    rows = []
    for s in SEASONS:
        g = season_strengths(s)
        if g is None:
            prev_teams = None
            continue
        teams_now = set(g.index)
        if prev_teams is not None:
            promoted = sorted(teams_now - prev_teams)
            for t in promoted:
                r = g.loc[t]
                rows.append({"season": s, "team": t, **{
                    k: float(r[k]) for k in
                    ["att", "def_", "att_home", "att_away", "def_home", "def_away"]}})
            print(f"  {s}: promoted = {promoted}")
        prev_teams = teams_now
        per_season[s] = g

    if not rows:
        raise RuntimeError("No promoted seasons resolved — cannot fit.")

    df = pd.DataFrame(rows)
    out = {
        "n_clubs": len(df),
        "seasons": sorted(df.season.unique()),
        "att": round(float(df.att.mean()), 3),
        "def": round(float(df["def_"].mean()), 3),
        "att_sd": round(float(df.att.std()), 3),
        "def_sd": round(float(df["def_"].std()), 3),
        "att_home_mult": round(float((df.att_home / df.att).mean()), 3),
        "att_away_mult": round(float((df.att_away / df.att).mean()), 3),
        "def_home_mult": round(float((df.def_home / df["def_"]).mean()), 3),
        "def_away_mult": round(float((df.def_away / df["def_"]).mean()), 3),
    }
    out["_table"] = df
    return out


if __name__ == "__main__":
    print("fitting promoted-side prior from real seasons")
    r = fit()
    df = r.pop("_table")
    print("\nEvery promoted club measured:")
    print(df.round(3).to_string(index=False))
    print(f"\nFITTED over {r['n_clubs']} promoted clubs, seasons {', '.join(r['seasons'])}")
    print(f"  attack   {r['att']}  (sd {r['att_sd']})   current hand-picked: 0.82")
    print(f"  defence  {r['def']}  (sd {r['def_sd']})   current hand-picked: 1.22")
    print(f"  venue multipliers — att home {r['att_home_mult']} / away {r['att_away_mult']}")
    print(f"                      def home {r['def_home_mult']} / away {r['def_away_mult']}")
    print(f"                      current hand-picked: att 1.10/0.90, def 0.93/1.07")
