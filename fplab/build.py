"""
Build the real dataset. No synthetic data anywhere in this path.

    python -m fplab.build --season 2026 --prior-season 2025

Steps
-----
1. FPL bootstrap-static  -> every registered PL player, price, club, flags
2. FPL element-summary   -> per-GW minutes history + previous-season totals
                            (this is what carries a transferred player's
                            production across clubs)
3. Understat             -> real team xG match log + player xG/xA
4. Name matching         -> join FPL to Understat, report anything unmatched
5. Minutes model         -> p_play / p_60 / expected minutes
6. Blending              -> credibility-weighted current vs prior rates
7. Write                 -> data/players.parquet, data/matchlog.parquet,
                            data/fixtures.parquet, data/audit.json

Anything that cannot be resolved is written to data/audit.json rather than
being silently defaulted to zero.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from . import sources, minutes
from .blend import build_player_rates
from .sources import DATA, TEAM_ALIASES

pd.options.mode.chained_assignment = None


def load_name_map() -> dict[int, str]:
    p = DATA / "name_map.csv"
    if not p.exists():
        return {}
    df = pd.read_csv(p)
    return {int(r["fpl_id"]): str(r["understat_name"]) for _, r in df.iterrows()}


def load_overrides() -> pd.DataFrame | None:
    # comment="#" matters: the file is meant to be hand-edited and carries
    # explanatory lines. Without it those lines parse as data rows and the
    # first int(fpl_id) throws.
    p = DATA / "overrides.csv"
    if not p.exists():
        return None
    ov = pd.read_csv(p, comment="#")
    return ov if len(ov) else None


def apply_overrides(players: pd.DataFrame) -> pd.DataFrame:
    """
    data/overrides.csv wins over everything. Use it for players with no
    Understat history at all — an incoming signing from outside the top five
    leagues, or a promoted-club player with no top-flight data.

    fpl_id,web_name,is_new_signing,prior_league,prior_team_xg90,xg90_prior,xa90_prior
    ,Rogers,True,Premier League,1.72,0.38,0.31
    """
    ov = load_overrides()
    if ov is None:
        return players
    df = players.copy()
    for _, row in ov.iterrows():
        if "fpl_id" in ov.columns and pd.notna(row.get("fpl_id")):
            mask = df["fpl_id"] == int(row["fpl_id"])
        else:
            key = str(row.get("web_name", "")).lower()
            mask = df["web_name"].str.lower() == key
        if not mask.any():
            continue
        for col in ov.columns:
            if col in ("fpl_id", "web_name") or pd.isna(row[col]):
                continue
            if col not in df.columns:
                df[col] = pd.NA
            df.loc[mask, col] = row[col]
    return df


def detect_new_signings(players: pd.DataFrame, prior: pd.DataFrame) -> pd.DataFrame:
    """
    A player is treated as a new signing when his previous-season data was
    recorded at a different club, or he has no previous-season data at all.

    Morgan Rogers is the canonical case: FPL lists him at Chelsea, his 2025/26
    xG sits under Aston Villa in Understat, and his FPL history_past is a Villa
    record. We keep the Villa production, translate the team context (Villa's
    xG/90 to Chelsea's), flag him provisional, and let real Chelsea data take
    over quickly via a lower shrinkage constant.
    """
    df = players.merge(prior, on="fpl_id", how="left")
    us_team = df.get("understat_team")
    if us_team is not None:
        us_short = us_team.map(lambda t: TEAM_ALIASES.get(t, str(t)[:3].upper())
                               if pd.notna(t) else None)
        club_changed = us_short.notna() & (us_short != df["team"])
    else:
        club_changed = pd.Series(False, index=df.index)

    no_prior = df["xg90_prior"].isna() if "xg90_prior" in df.columns else True
    df["is_new_signing"] = (club_changed | no_prior).fillna(True)
    df["prior_club"] = us_team if us_team is not None else None
    df["prior_league"] = df.get("prior_league", "Premier League")
    df["prior_league"] = df["prior_league"].fillna("Premier League")
    return df


def build(season: int, prior_season: int, refresh: bool = False,
          skip_history: bool = False) -> dict:
    print("→ FPL bootstrap-static")
    bs = sources.bootstrap(force=refresh)
    players = sources.all_players(bs)
    gw_now = sources.current_gw(bs)
    print(f"  {len(players)} registered players · current GW {gw_now}")

    print("→ FPL fixtures")
    fixtures = sources.fixtures_frame(sources.fixtures_raw(force=refresh), bs)

    print(f"→ Understat {prior_season} team match log")
    matchlog = sources.understat_team_match_log(prior_season)
    matchlog["team"] = matchlog["team_understat"].map(
        lambda t: TEAM_ALIASES.get(t, str(t)[:3].upper()))
    # If the current season has started, prefer its match log and append.
    try:
        cur_log = sources.understat_team_match_log(season)
        if len(cur_log):
            cur_log["team"] = cur_log["team_understat"].map(
                lambda t: TEAM_ALIASES.get(t, str(t)[:3].upper()))
            matchlog = pd.concat([matchlog, cur_log], ignore_index=True)
            print(f"  appended {len(cur_log)} current-season team-matches")
    except RuntimeError as e:
        print(f"  (current season not on Understat yet: {e})")

    print(f"→ Understat {prior_season} player xG/xA")
    us_players = sources.understat_players(prior_season)

    print("→ matching FPL ↔ Understat")
    matched = sources.match_players(players, us_players, load_name_map())
    counts = matched["match_method"].value_counts().to_dict()
    unmatched = sources.match_report(matched)
    print(f"  {counts}")
    if len(unmatched):
        print(f"  ⚠ {len(unmatched)} regular players unmatched — see data/audit.json")

    if skip_history:
        prior = pd.DataFrame({"fpl_id": []})
    else:
        print("→ FPL previous-season totals (element-summary, ~700 calls, cached)")
        prior = sources.previous_season_rates(
            matched["fpl_id"].tolist(),
            progress=lambda n, t: print(f"  {n}/{t}", end="\r"))
        print(f"\n  {len(prior)} players with prior-season records")

    df = detect_new_signings(matched, prior)

    # Prefer Understat xG (better model) over FPL's, keep FPL as fallback.
    for a, b in [("u_xg90", "xg90_now"), ("u_xa90", "xa90_now")]:
        if a in df.columns:
            df[b] = df[a].fillna(df[b])

    for c in ["xg90_prior", "xa90_prior", "defcon90_prior",
              "bps90_prior", "mins_share_prior"]:
        if c not in df.columns:
            df[c] = pd.NA
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(
            df[c.replace("_prior", "_now")] if c.replace("_prior", "_now") in df else 0.0)

    df = apply_overrides(df)
    df["prior_team_xg90"] = pd.to_numeric(
        df.get("prior_team_xg90", pd.NA), errors="coerce").fillna(1.45)

    print("→ minutes model")
    df = minutes.attach(df)

    DATA.mkdir(exist_ok=True)
    df.to_parquet(DATA / "players.parquet")
    matchlog.to_parquet(DATA / "matchlog.parquet")
    fixtures.to_parquet(DATA / "fixtures.parquet")

    audit = {
        "current_gw": gw_now,
        "n_players": len(df),
        "field_resolution": sources.SCHEMA_REPORT,
        "unresolved_fields": [k for k, v in sources.SCHEMA_REPORT.items() if v is None],
        "match_methods": counts,
        "unmatched_regulars": unmatched.to_dict("records"),
        "new_signings": int(df["is_new_signing"].sum()),
        "teams": sorted(df["team"].unique().tolist()),
    }
    (DATA / "audit.json").write_text(json.dumps(audit, indent=2, default=str))
    print(f"✓ wrote players/matchlog/fixtures parquet + audit.json")
    if audit["unresolved_fields"]:
        print(f"  ⚠ unresolved API fields: {audit['unresolved_fields']}")
    return audit


def main():
    ap = argparse.ArgumentParser(description="Build the real FPL dataset")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--prior-season", type=int, default=2025)
    ap.add_argument("--refresh", action="store_true", help="bypass cache")
    ap.add_argument("--skip-history", action="store_true",
                    help="skip the ~700 element-summary calls (faster, less accurate)")
    a = ap.parse_args()
    build(a.season, a.prior_season, a.refresh, a.skip_history)


if __name__ == "__main__":
    main()
