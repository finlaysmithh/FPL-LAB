"""
Build the PRIOR-SEASON half of the dataset from real, complete historical
data — no live FPL API or Understat access required.

Source: vaastav/Fantasy-Premier-League on GitHub (raw.githubusercontent.com,
reachable with no auth). For a finished season this is literally the FPL
API's own numbers, archived: real per-gameweek xG, xA, DefCon, bps, minutes,
prices, for every player who featured.

This gives us:
  1. A real team-match xG log  -> real team strength ratings (ratings.py runs
     on this exactly as it would on Understat).
  2. Real player prior-season rates (xG90, xA90, DefCon90, bps90, minutes
     share) -> the "prior" side of every blend in blend.py.

What it CANNOT give us (this is the honest boundary):
  - Live 2026/27 prices, squad numbers, injury flags — those only exist on
    fantasy.premierleague.com, which blocks datacentre IPs.
  - Which club a player is registered at THIS summer — e.g. Rogers shows here
    as Aston Villa, because that's where he played in 2025/26. His transfer to
    Chelsea is 2026/27 news and has to come from bootstrap-static.

So this build produces a fully real, fully populated PRIOR dataset. Treat it
as "what every player did last season", and layer this summer's transfers
and prices on top via data/overrides.csv until bootstrap-static is reachable
(from a home connection, not this sandbox).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).resolve().parent.parent / "data"
VBASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"

POS_MAP = {"GK": "GK", "GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}


def _download(season: str, path: str, out: Path) -> pd.DataFrame:
    import requests
    url = f"{VBASE}/{season}/{path}"
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r.content)
    return pd.read_csv(out)


def fetch_season(season: str, force: bool = False, require_gws: bool = True) -> dict[str, pd.DataFrame]:
    """season format: '2025-26'."""
    base = DATA / f"vaastav_{season}"
    out = {}
    for name, path in [("players", "players_raw.csv"),
                       ("teams", "teams.csv"),
                       ("fixtures", "fixtures.csv"),
                       ("gws", "gws/merged_gw.csv")]:
        p = base / path
        try:
            if p.exists() and not force:
                out[name] = pd.read_csv(p)
            else:
                out[name] = _download(season, path, p)
        except Exception as e:
            if name == "gws" and not require_gws:
                # Pre-season: no gameweeks played yet under this season's
                # export. Real absence, not an error — return an empty frame
                # with the right columns so downstream code doesn't special-case it.
                out[name] = pd.DataFrame(columns=[
                    "element", "name", "minutes", "expected_goals", "expected_assists",
                    "defensive_contribution", "bps", "starts", "total_points", "GW"])
            else:
                raise
    return out


def team_match_log(gws: pd.DataFrame, teams: pd.DataFrame) -> pd.DataFrame:
    """
    Real team-level xG per match, aggregated from real player-level xG.

    merged_gw.csv is one row per (player, gameweek-they-featured). Summing
    expected_goals across all players on a team for a given fixture recovers
    the team's real xG for that match — this is exactly the number Understat
    would report, derived from FPL's own archived data instead.
    """
    id_to_name = dict(zip(teams["id"], teams["name"]))
    short = dict(zip(teams["id"], teams["short_name"]))

    g = gws.copy()
    # In recent vaastav seasons `team` is already the team's full name string.
    # Detect by content (checking against `name`, not `short_name` — the
    # column holds "Arsenal", not "ARS") rather than dtype, since a pandas
    # StringDtype column is NOT `== object` and that check silently produced
    # all-NaN team names with the groupby then dropping every row.
    full_name = dict(zip(teams["id"], teams["name"]))
    short = dict(zip(teams["id"], teams["short_name"]))
    name_to_id = {v: k for k, v in full_name.items()}
    is_already_name = g["team"].astype(str).isin(full_name.values()).mean() > 0.5
    g["team_name"] = g["team"] if is_already_name else g["team"].map(full_name)

    per_match = (
        g.groupby(["fixture", "team_name", "was_home", "opponent_team", "GW"])
        .agg(xg_for=("expected_goals", "sum"),
            goals_for=("goals_scored", "sum"),
            xg_conceded_stat=("expected_goals_conceded", "mean"))
        .reset_index()
    )
    # expected_goals_conceded is a defender-facing stat (team's xGA per
    # player who played); use the opponent's xg_for as this team's xg_against
    # for a cleaner attack/defence split.
    opp_xg = per_match.set_index(["fixture", "team_name"])["xg_for"]

    rows = []
    for fixture_id, grp in per_match.groupby("fixture"):
        if len(grp) != 2:
            continue
        a, b = grp.iloc[0], grp.iloc[1]
        for me, opp in [(a, b), (b, a)]:
            rows.append({
                "team": short.get(name_to_id.get(me["team_name"]), me["team_name"]),
                "opponent": short.get(name_to_id.get(opp["team_name"]), opp["team_name"]),
                "was_home": bool(me["was_home"]),
                "xg_for": float(me["xg_for"]),
                "xg_against": float(opp["xg_for"]),
                "kickoff": int(me["GW"]) * 10 + (0 if me["was_home"] else 1),
            })
    return pd.DataFrame(rows).sort_values("kickoff").reset_index(drop=True)


def player_prior_rates(players: pd.DataFrame, gws: pd.DataFrame, teams: pd.DataFrame) -> pd.DataFrame:
    """
    Real season-total rates per player, ready to feed blend.py as the
    `*_prior` columns. Team is output as the short code (e.g. "AVL") to match
    team_match_log's keys.
    """
    # DefCon and its component stats (tackles, recoveries, CBI) only exist in
    # FPL's export from 2025/26 — the season the scoring rule was introduced.
    # Older archives are real data with those columns genuinely absent, not
    # broken, so fill them with zero rather than failing: a backtest over
    # 2023-24 must still run, it simply cannot score a rule that did not exist.
    gws = gws.copy()
    for c in ("defensive_contribution", "clearances_blocks_interceptions",
              "tackles", "recoveries", "starts", "expected_goals",
              "expected_assists", "bps", "total_points", "minutes",
              "yellow_cards", "red_cards", "saves", "assists"):
        if c not in gws.columns:
            gws[c] = 0.0

    agg = (
        gws.groupby(["element", "name"])
        .agg(
            minutes=("minutes", "sum"),
            xg=("expected_goals", "sum"),
            xa=("expected_assists", "sum"),
            defcon=("defensive_contribution", "sum"),
            cbi=("clearances_blocks_interceptions", "sum"),
            tackles=("tackles", "sum"),
            recoveries=("recoveries", "sum"),
            bps=("bps", "sum"),
            starts=("starts", "sum"),
            total_points=("total_points", "sum"),
            yellow=("yellow_cards", "sum"),
            red=("red_cards", "sum"),
            saves=("saves", "sum"),
        )
        .reset_index()
    )
    # Rates measured on SUBSTANTIAL appearances, used selectively below.
    # A blanket 60-minute filter is NOT applied: league-wide it LOWERS xG90
    # (0.1286 -> 0.1193), because attacking substitutes chasing a game carry a
    # high xG per minute. It only helps players whose season is mostly cameos,
    # which is exactly the injury case (Isak: 0.336 -> 0.375, +12%).
    sub = gws[gws["minutes"] >= 45]
    fit = (sub.groupby("element")
              .agg(fit_min=("minutes", "sum"), fit_xg=("expected_goals", "sum"),
                   fit_xa=("expected_assists", "sum"))
              .reset_index())
    agg = agg.merge(fit, on="element", how="left")
    agg["n90"] = agg["minutes"] / 90.0
    d = agg["n90"].clip(lower=0.5)
    agg["xg90_prior"] = agg["xg"] / d
    agg["xa90_prior"] = agg["xa"] / d

    # Injury-diluted seasons: when most of a player's minutes came in cameos,
    # his season-long per-90 is garbage-time-weighted and understates the rate
    # he produces at when actually starting. Where he has a usable sample of
    # substantial appearances AND cameos make up a real share of his season,
    # prefer the substantial-minutes rate. Everyone else keeps the full-season
    # figure, which is the larger and therefore better-estimated sample.
    fit_n90 = (agg["fit_min"].fillna(0.0) / 90.0)
    cameo_share = 1.0 - (agg["fit_min"].fillna(0.0) / agg["minutes"].clip(lower=1))
    use_fit = (fit_n90 >= 4) & (cameo_share > 0.15)
    fd = fit_n90.clip(lower=0.5)
    agg.loc[use_fit, "xg90_prior"] = (agg["fit_xg"] / fd)[use_fit]
    agg.loc[use_fit, "xa90_prior"] = (agg["fit_xa"] / fd)[use_fit]
    agg["rate_basis"] = np.where(use_fit, "substantial_minutes", "full_season")
    agg["defcon90_prior"] = agg["defcon"] / d
    agg["bps90_prior"] = agg["bps"] / d
    agg["cbi90_prior"] = agg["cbi"] / d
    agg["mins_share_prior"] = (agg["minutes"] / (38 * 90)).clip(upper=1.0)
    # Cards and saves were never aggregated, so `yellow90` and `saves90` sat at
    # zero for every player — cards contributed nothing and saves fired for no
    # goalkeeper at all (0 of 63 non-zero).
    agg["yellow90_prior"] = agg["yellow"] / d
    agg["red90_prior"] = agg["red"] / d
    agg["saves90_prior"] = agg["saves"] / d

    # Raw assist and xA totals, carried through un-normalised so that
    # blend.assist_multiplier can weigh them as counts. A per-90 rate would
    # throw away exactly the sample size that decides how far a player is
    # allowed off the positional constant.
    #
    # Restricted to gameweeks in which the league recorded ANY xA. FPL published
    # no expected stats before GW16 of 2022-23, so a full-season total there
    # divides 38 matches of assists by 22 of xA and reads A/xA 2.11 against a
    # true 1.36 — an artefact that would hand every 2022-23 player a fictitious
    # inflation. Detected from the data rather than hardcoded by season, so any
    # future gap in the feed is handled the same way.
    xa_by_gw = gws.groupby("GW")["expected_assists"].sum()
    live_gws = set(xa_by_gw[xa_by_gw > 0].index)
    infl = gws[gws["GW"].isin(live_gws)] if live_gws else gws.iloc[0:0]
    infl_agg = (infl.groupby("element")
                    .agg(assists_prior=("assists", "sum"),
                         xa_total_prior=("expected_assists", "sum"))
                    .reset_index())
    agg = agg.merge(infl_agg, on="element", how="left")
    agg["assists_prior"] = agg["assists_prior"].fillna(0.0)
    agg["xa_total_prior"] = agg["xa_total_prior"].fillna(0.0)

    id_to_short = dict(zip(teams["id"], teams["short_name"]))
    meta = players[["id", "first_name", "second_name", "team", "element_type"]].copy()
    meta["position"] = meta["element_type"].map({1: "GK", 2: "DEF", 3: "MID", 4: "FWD"})
    meta["full_name"] = meta["first_name"] + " " + meta["second_name"]
    meta["team_short"] = meta["team"].map(id_to_short)

    out = agg.merge(meta, left_on="element", right_on="id", how="left")
    return out[[
        "element", "name", "full_name", "team_short", "position",
        "xg90_prior", "xa90_prior", "defcon90_prior", "bps90_prior",
        "cbi90_prior", "mins_share_prior", "minutes", "total_points",
        "yellow90_prior", "red90_prior", "saves90_prior", "rate_basis",
        "assists_prior", "xa_total_prior",
    ]].rename(columns={"element": "prior_fpl_id", "team_short": "team"})


def build(season: str = "2025-26", force: bool = False) -> dict:
    print(f"→ downloading real {season} season data from vaastav/Fantasy-Premier-League")
    d = fetch_season(season, force)
    print(f"  players={len(d['players'])}  gw-rows={len(d['gws'])}  teams={len(d['teams'])}")

    print("→ deriving real team-match xG log")
    matchlog = team_match_log(d["gws"], d["teams"])
    print(f"  {len(matchlog)} team-match rows across {matchlog['team'].nunique()} teams")

    print("→ real player prior-season rates")
    priors = player_prior_rates(d["players"], d["gws"], d["teams"])
    print(f"  {len(priors)} players with {season} rates")

    DATA.mkdir(exist_ok=True)
    matchlog.to_parquet(DATA / "matchlog_prior.parquet")
    priors.to_parquet(DATA / "players_prior.parquet")
    print(f"✓ wrote data/matchlog_prior.parquet, data/players_prior.parquet")
    print(f"  This is REAL {season} data. Layer current prices/transfers via "
         f"data/overrides.csv or bootstrap-static once reachable.")
    return {"matchlog": matchlog, "priors": priors}


def main():
    ap = argparse.ArgumentParser(description="Build the real prior-season dataset")
    ap.add_argument("--season", default="2025-26")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    build(a.season, a.force)


if __name__ == "__main__":
    main()
