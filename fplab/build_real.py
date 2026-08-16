"""
Final assembly: stitch the REAL current-season registry (2026/27, pre-season)
to the REAL prior-season rates and match log (2025/26, complete).

Both halves come from vaastav/Fantasy-Premier-League on GitHub, which is
reachable from this sandbox — no live FPL API or Understat access needed.

    python -m fplab.build_real

Produces the same three files build.py would have produced from the live
API: data/players.parquet, data/matchlog.parquet, data/fixtures.parquet —
so pipeline.load() works identically either way.

Honesty about what this is and isn't:
  - Squad registry, prices, positions: REAL, current, from the 2026/27
    players_raw.csv (567 players already carrying summer transfers).
  - Fixture list: REAL, the actual 380-fixture 2026/27 calendar.
  - Team strength / FDR: REAL, derived from the complete 2025/26 season.
  - Player rates (xG90 etc.): REAL 2025/26 production, credibility-blended.
    Since no 2026/27 minutes exist yet (pre-season), the blend sits at
    w_now=0 — 100% prior — which is the mathematically correct state for a
    GW1 projection, not an approximation.
  - Injury flags / chance_of_playing: NOT available pre-season from this
    source (they update live during the season). Defaulted to "available"
    with a note in the audit; check bootstrap-static nearer GW1 for these.
"""
from __future__ import annotations

import json

import pandas as pd

# Aliased: this module defines its own `build()`, which would shadow the
# module and turn every attribute lookup on it into an AttributeError.
from . import build as build_mod
from . import (build_prior, lineups, minutes as minutes_mod, penalties, ratings,
               roles, rules_2026_27, team_history)
from .sources import DATA, TEAM_ALIASES

CUR_SEASON = "2026-27"
PRIOR_SEASON = "2025-26"


def fetch_current_registry(season: str = CUR_SEASON, force: bool = False) -> dict:
    """
    This season's squad registry, prices, injury flags and fixture list.

    Prefers FPL's own live `bootstrap-static` over the cached vaastav CSV,
    because the CSV is a periodic snapshot and the transfer window is not.
    Measured at build time: the archive held 567 players with Bruno Guimaraes
    still at Newcastle; the live endpoint held 581 with him at Arsenal. A squad
    picked off a stale registry can contain a player who has left the club, and
    the model has no way to notice.
    """
    try:
        from . import sources
        bs = sources.bootstrap(force=force)
        players = pd.DataFrame(bs["elements"])
        teams = pd.DataFrame(bs["teams"])
        fixtures = pd.DataFrame(sources.fixtures_raw(force=force))
        if len(players) and len(teams) == 20 and len(fixtures):
            # Managers were added as element_type 5 in 2024/25. They are scored
            # by different rules and the xP engine has never modelled them, so
            # drop them rather than half-score them.
            players = players[players["element_type"].isin((1, 2, 3, 4))]
            n_flag = int((players["status"] != "a").sum())
            print(f"  registry: LIVE bootstrap-static ({len(players)} players, "
                  f"{n_flag} carrying an injury or availability flag)")
            return {"players": players, "teams": teams, "fixtures": fixtures,
                    "source": "live"}
    except Exception as e:                       # offline, rate-limited, schema drift
        print(f"  ! live registry unavailable ({type(e).__name__}: {e}); "
              f"falling back to the archived snapshot")

    d = build_prior.fetch_season(season, force, require_gws=False)
    d["source"] = "archive"
    print(f"  registry: archived CSV ({len(d['players'])} players) — "
          f"may lag the transfer window")
    return d


def build(force: bool = False) -> dict:
    print(f"→ real prior-season data ({PRIOR_SEASON})")
    prior = build_prior.build(PRIOR_SEASON, force=force)

    print(f"→ real current registry ({CUR_SEASON}, pre-season)")
    cur = fetch_current_registry(CUR_SEASON, force)
    p, t, f = cur["players"], cur["teams"], cur["fixtures"]
    print(f"  {len(p)} players registered, {len(t)} teams, {len(f)} fixtures")

    id_to_short = dict(zip(t["id"], t["short_name"]))

    # ---- players ----------------------------------------------------
    players = p.copy()
    players["fpl_id"] = players["id"]
    players["web_name"] = players["web_name"] if "web_name" in players else (
        players["first_name"].str[0] + ". " + players["second_name"])
    players["full_name"] = players["first_name"] + " " + players["second_name"]
    players["team"] = players["team"].map(id_to_short)
    players["position"] = players["element_type"].map(
        {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"})
    players["price"] = players["now_cost"] / 10.0
    players["ownership"] = pd.to_numeric(
        players.get("selected_by_percent", 0), errors="coerce").fillna(0.0)
    players["status"] = players.get("status", "a").fillna("a")
    players["chance_playing"] = players.get("chance_of_playing_next_round")
    players["news"] = players.get("news", "")
    players["penalties_order"] = players.get("penalties_order")
    players["corners_order"] = players.get("corners_and_indirect_freekicks_order")
    players["fk_order"] = players.get("direct_freekicks_order")

    # Pre-season: no minutes played yet under the NEW season. This is
    # correct, not missing — n90_now=0 forces the blend to 100% prior.
    players["minutes"] = 0
    players["n90_now"] = 0.0
    players["mins_share_now"] = 0.0
    players["xg90_now"] = 0.0
    players["xa90_now"] = 0.0
    players["defcon90_now"] = 0.0
    players["bps90_now"] = 0.0
    players["saves90"] = 0.0
    players["yellow90"] = 0.0
    # No assists or xA under the new season yet, so the assist multiplier rests
    # entirely on the prior-season totals attached below.
    players["assists_now"] = 0.0
    players["xa_total_now"] = 0.0
    players["start_rate"] = float("nan")
    players["p60_rate"] = float("nan")
    players["mins_per_start"] = float("nan")

    # ---- attach real prior-season rates, matching by FPL element id ----
    priors = prior["priors"]
    id_map = build_id_bridge(p, cur_season=CUR_SEASON, prior_season=PRIOR_SEASON)
    players = players.merge(id_map, left_on="fpl_id", right_on="cur_fpl_id", how="left")
    players = players.merge(
        priors.drop(columns=["team", "position", "full_name"], errors="ignore"),
        left_on="prior_fpl_id", right_on="prior_fpl_id", how="left")

    for c in ["xg90_prior", "xa90_prior", "defcon90_prior", "bps90_prior",
              "cbi90_prior", "mins_share_prior", "assists_prior", "xa_total_prior"]:
        if c not in players.columns:
            players[c] = 0.0
        players[c] = players[c].fillna(0.0)

    # ---- multi-season production rates (reversion to the mean) -------------
    # Rates above come from ONE prior season, which treats a small interrupted
    # sample as a player's true level: Isak's 0.336 xG90 rests on 7.7 full
    # matches of an injury-wrecked year against 0.66-0.81 in the two before it.
    # `player_history` blends seasons weighted by decay AND by sample size, so
    # a thin recent season yields to a substantial older one automatically.
    # Validated out of sample in both holdout years — see that module.
    #
    # Only production rates are replaced. Minutes are deliberately left on the
    # latest season, because how good a player is persists and how big his role
    # is does not — blending three seasons of Isak's minutes would leave half
    # his role at Newcastle.
    hist_path = DATA / "player_history.parquet"
    if hist_path.exists() and "code" in players.columns:
        hist = pd.read_parquet(hist_path)
        rate_map = {"xg90": "xg90_prior", "xa90": "xa90_prior",
                    "bps90": "bps90_prior", "defcon90": "defcon90_prior",
                    "cbi90": "cbi90_prior", "saves90": "saves90_prior",
                    "yellow90": "yellow90_prior", "red90": "red90_prior"}
        h = hist.rename(columns={k: f"_h_{v}" for k, v in rate_map.items()})
        # The carried SHARE of team creation, and the club context it was
        # earned in. `blend.build_player_rates` restates the share against the
        # player's CURRENT club — it is the only place that knows the current
        # team xG90 — so these travel through untouched. See player_history.
        h = h.rename(columns={"xg_share": "xg_share_prior",
                              "xa_share": "xa_share_prior",
                              "team_xg90": "prior_ctx_xg90",
                              "hist_clubs": "hist_clubs",
                              "hist_last_club": "hist_last_club"})
        share_cols = [c for c in ("xg_share_prior", "xa_share_prior",
                                  "prior_ctx_xg90", "hist_clubs",
                                  "hist_last_club", "hist_n_clubs")
                      if c in h.columns]
        players = players.merge(
            h[["code", "hist_n90", "hist_seasons", "career_n90", "mins_share_hist",
               *share_cols, *[f"_h_{v}" for v in rate_map.values()]]],
            on="code", how="left")
        moved = 0
        for col in rate_map.values():
            src = f"_h_{col}"
            use = players[src].notna()
            if col == "xg90_prior":
                moved = int(((players.loc[use, src]
                              - players.loc[use, col]).abs() > 0.05).sum())
            # Keep the player's OWN historical rate alongside the column that
            # later steps are free to overwrite. Without it there is no way to
            # tell, downstream or in `explain`, whether a rate is what the
            # player did or what his price band did — which is exactly the
            # question a projection that looks wrong turns on.
            if col == "xg90_prior":
                players["_hist_xg90"] = players[src]
            players.loc[use, col] = players.loc[use, src]
            players.drop(columns=[src], inplace=True)
        n_multi = int((players["hist_seasons"].fillna(0) >= 2).sum())
        print(f"  multi-season rates for {n_multi} players "
              f"({moved} moved by 0.05+ xG90); minutes left on the latest season")
    else:
        players["hist_seasons"] = 1.0
        players["career_n90"] = players.get("prior_minutes", 0) / 90.0
        print("  ! data/player_history.parquet missing — run "
              "`python -m fplab.player_history` for multi-season rates")

    # ---- availability-adjusted prior minutes share -------------------------
    # `mins_share_prior` above is season minutes / (38*90), which cannot tell a
    # rotation player from a starter who missed ten weeks injured — both arrive
    # as "0.6 of a season". That matters because THIS season's injuries are
    # already applied separately, per gameweek, by `fplab.availability`, so an
    # injury-depressed prior gets charged twice: once as a permanently smaller
    # role and again as a live flag.
    #
    # `fplab.fit_minutes` measures the share over the gameweeks a player was
    # plausibly available, and that is the right input to a forward-looking
    # "what does he play when fit" estimate. Where it is missing (a player with
    # too little history to classify) the raw share stands.
    # A role measured over a part-season is a part-measurement. Where the
    # multi-season blend says a player's usual share is materially higher than
    # his most recent one, take the blend — this is what stops an injury year
    # being read as a permanent demotion. See fplab/player_history.py.
    if "mins_share_hist" in players.columns:
        _mh = pd.to_numeric(players["mins_share_hist"], errors="coerce")
        players["mins_share_hist"] = _mh

    fit_path = DATA / "minutes_prior_fit.parquet"
    if fit_path.exists():
        fit = pd.read_parquet(fit_path)[["prior_fpl_id", "mins_share_fit",
                                         "n_avail_prior", "mins_per_start"]]
        fit = fit.rename(columns={"mins_per_start": "mins_per_start_prior"})
        players = players.merge(fit, on="prior_fpl_id", how="left")
        players["mins_share_observed"] = players["mins_share_prior"]
        use = players["mins_share_fit"].notna() & (players["n_avail_prior"] >= 8)
        lifted = (players.loc[use, "mins_share_fit"]
                  - players.loc[use, "mins_share_prior"])
        players.loc[use, "mins_share_prior"] = players.loc[use, "mins_share_fit"]
        # Lift toward the multi-season role where the recent season was short.
        if "mins_share_hist" in players.columns:
            mh = players["mins_share_hist"]
            lift = mh.notna() & (mh > players["mins_share_prior"])
            n_lift = int(lift.sum())
            players.loc[lift, "mins_share_prior"] = mh[lift]
            print(f"  minutes lifted toward the multi-season role for {n_lift} "
                  f"players whose recent season was short")
        print(f"  availability-adjusted minutes for {int(use.sum())} players "
              f"(mean lift {lifted.mean():+.3f}, "
              f"{int((lifted > 0.10).sum())} lifted by 0.10+)")
    else:
        players["mins_share_observed"] = players["mins_share_prior"]
        players["mins_per_start_prior"] = float("nan")
        print("  ! data/minutes_prior_fit.parquet missing — run "
              "`python -m fplab.fit_minutes` for availability-adjusted minutes")

    # How long a player lasts WHEN he starts is a separate fact from how often
    # he starts, and conflating them punishes exactly the wrong players. A
    # striker who starts 89% of matches and is withdrawn on 86 minutes carries
    # the same 0.86 minutes share as one who starts 86% and plays the full 90 —
    # but the first is nailed and the second is not, and only the first should
    # survive a squad-concentration step. Haaland is the case in point: his own
    # measured figures are a 0.895 start rate and 86.4 minutes per start.
    # Where there is no measurement, the fitted population curve stands in.
    curves = roles.load_curves()
    mps = pd.to_numeric(players.get("mins_per_start_prior"), errors="coerce")
    fallback = (curves["mps_intercept"]
                + curves["mps_slope"] * players["mins_share_prior"].fillna(0.0))
    players["mins_per_start_prior"] = mps.fillna(fallback).clip(45.0, 90.0)

    # ---- 2026/27 BPS recalibration ----------------------------------------
    # FPL cut the weight of CBI inside BPS to reduce its overlap with DefCon.
    # Prior-season BPS was earned under the OLD rules, so it must be restated
    # before it is used to project bonus, or CBI-heavy centre-backs are
    # systematically overrated.
    players = rules_2026_27.adjust_bps_for_2026_27(players)
    dpos = players.groupby("position")["bps_delta_pct"].mean().round(1).to_dict()
    print(f"  BPS restated for 2026/27 rules — mean change by position: {dpos}")

    # ---- minutes: correct raw prior minutes share for injury/disruption ----
    # Raw last-season minutes share badly misprices anyone who missed time.
    # Shrink it toward the price-implied expectation (see minutes.py).
    players["prior_minutes"] = pd.to_numeric(
        players.get("minutes_y", players.get("minutes")), errors="coerce").fillna(0.0)

    # New-signing / club-change detection must happen BEFORE the minutes guard:
    # the guard routes a player with no PL minutes down the price-proxy path
    # only if he actually just arrived. A squad player who sat on the bench all
    # season is evidence, not missing data, and takes the fringe path instead.
    players["prior_club"] = players.get("prior_team")
    no_prior = players["prior_fpl_id"].isna()
    club_changed = (players["prior_club"].notna()
                    & (players["prior_club"] != players["team"]))
    players["is_new_signing"] = (no_prior | club_changed).fillna(True)

    # data/overrides.csv is applied HERE, immediately before the minutes guard,
    # for two reasons. It was previously only wired into build.py, so on this
    # path — the one that actually builds the real dataset — the file was read
    # by nothing and every override in it was silently ignored. And it has to
    # land before the guard because the columns it carries (`fit_starter`,
    # `mins_share_override`) are inputs to the guard, not corrections to its
    # output.
    players = build_mod.apply_overrides(players)
    n_ov = sum(c in players.columns for c in ("fit_starter", "mins_share_override"))
    if n_ov:
        declared = minutes_mod._truthy(players["fit_starter"]).sum() \
            if "fit_starter" in players.columns else 0
        manual = pd.to_numeric(players["mins_share_override"], errors="coerce").notna().sum() \
            if "mins_share_override" in players.columns else 0
        if declared or manual:
            print(f"  overrides — {int(declared)} declared fit starters, "
                  f"{int(manual)} manual minutes shares")

    guard = minutes_mod.minutes_guard(players)
    players["mins_share_raw"] = guard["mins_share_raw"]
    players["minutes_ceiling"] = guard["minutes_ceiling"]
    players["mins_share_prior"] = guard["mins_share"]
    players["exp_mins"] = guard["exp_mins"]
    players["minutes_flag"] = guard["minutes_flag"]
    players["no_pl_history"] = minutes_mod.no_history_mask(players)

    # ---- predicted XIs, for players the model has no basis to rank ---------
    # Runs AFTER the minutes guard so it can see which players the guard had to
    # fall back on price for, and floors only those. See fplab/lineups.py.
    players, xi_report = lineups.apply_xi_floor(players)
    if xi_report["matched"]:
        print(f"  predicted XI — {xi_report['matched']} named players matched, "
              f"{xi_report['lifted']} uninformed players floored")
        if xi_report["unmatched"]:
            print(f"    unmatched (stale file?): "
                  f"{', '.join(xi_report['unmatched'][:12])}"
                  f"{' …' if len(xi_report['unmatched']) > 12 else ''}")
        players["exp_mins"] = players["mins_share_prior"] * 90.0

    # Card and save rates. These columns existed and were never populated, so
    # `yellow90` and `saves90` sat at 0.0 for all 567 players: cards scored
    # nothing and saves fired for no goalkeeper at all. The prior-season
    # aggregation now carries them.
    for now_col, prior_col in (("yellow90", "yellow90_prior"),
                               ("red90", "red90_prior"),
                               ("saves90", "saves90_prior")):
        players[now_col] = pd.to_numeric(
            players.get(prior_col), errors="coerce").fillna(0.0)
    # Players with no usable PL record (transfers from abroad, long loans)
    # would otherwise project ZERO production. Give them a price-implied prior.
    players = minutes_mod.price_implied_production(players)
    n_imp = int(players["price_implied_prior"].sum())
    print(f"  {n_imp} players given price-implied production priors "
          f"(no usable PL history — foreign transfers, loans)")

    # A price-implied prior REPLACES the historical one, so the carried share
    # has to go with it — otherwise `blend` restates a stale share against the
    # new club and silently reinstates the record this step just decided was
    # not worth using. Rashford is the case: a season at Barcelona leaves his
    # last PL share three years old, and the build has already judged his price
    # the better estimate. The price proxy is a league-wide positional rate,
    # not a share of any particular club's creation, so it is correct to feed
    # it through as a rate and let it be.
    # Only where the proxy actually DOMINATES. Now that a price-implied rate is
    # blended with the player's own record rather than replacing it, dropping
    # the share wherever the proxy merely fired would throw away the history of
    # players who just kept most of theirs — and the share is the better of the
    # two routes anyway, being corrected for the club he now plays at.
    imp = players["rate_mostly_price"].fillna(False).astype(bool)
    for c in ("xg_share_prior", "xa_share_prior"):
        if c in players.columns:
            players.loc[imp, c] = float("nan")
    print(f"  carried share dropped for {int(imp.sum())} players whose rate is "
          f"mostly price-derived; kept for the rest")
    moved = (players["mins_share_prior"] - players["mins_share_raw"]).abs()
    fl = players["minutes_flag"].value_counts()
    print(f"  minutes prior adjusted for {(moved > 0.15).sum()} players "
          f"(largest shift {moved.max():.2f}); "
          f"{int(players['no_pl_history'].sum())} have no PL history")
    print(f"  minutes guard — fringe capped: {int(fl.get('fringe', 0))}, "
          f"new-signing price proxy: {int(fl.get('new_signing_price_proxy', 0))}, "
          f"clear #1 GK floored: {int(fl.get('clear_first_choice_gk', 0))}, "
          f"declared fit starters: {int(fl.get('declared_fit_starter', 0))}, "
          f"manual: {int(fl.get('manual_minutes', 0))}")

    # ---- penalties: strip last season's pen xG, add this season's ----------
    # Requires real team attacking strength, so build ratings from the real
    # 2025/26 match log first.
    rt = ratings.team_ratings(prior["matchlog"])
    att_by_team = {t: float(rt.at[t, "att"]) for t in rt.index}
    players = penalties.correct_prior_for_penalties(players, att_by_team)
    n_takers = int(players["is_pen_taker"].sum())
    print(f"  {n_takers} listed penalty takers; unlisted players credited 0 pen xG")

    players["provisional_minutes"] = players["no_pl_history"]
    players["provisional"] = players.get("provisional", False) | players["no_pl_history"]
    players["prior_league"] = "Premier League"
    # The club context the prior rates were actually earned in, not a flat
    # league average. Where the multi-season history resolved it (every player
    # with PL minutes), use it; a player with no PL history has no context to
    # carry and falls back to the league mean.
    players["prior_team_xg90"] = pd.to_numeric(
        players.get("prior_ctx_xg90", pd.NA), errors="coerce").fillna(1.45)

    # ---- fixtures ------------------------------------------------------
    fixtures = pd.DataFrame({
        "gw": f["event"],
        "home": f["team_h"].map(id_to_short),
        "away": f["team_a"].map(id_to_short),
        "kickoff": f.get("kickoff_time"),
        "finished": f.get("finished", False).fillna(False)
                    if hasattr(f.get("finished", False), "fillna") else False,
    }).dropna(subset=["gw"])
    fixtures["gw"] = fixtures["gw"].astype(int)

    # ---- matchlog: three seasons of real team xG, not one --------------------
    # One season is too short a measurement to rate a defence on — it had
    # Liverpool at exactly league average and turned Anfield into a green
    # fixture. See fplab.team_history for the evidence and the decay weights.
    try:
        matchlog = team_history.build()
        print(f"  team ratings from {len(matchlog)} team-matches across "
              f"{len(team_history.SEASONS)} seasons")
    except FileNotFoundError as e:
        matchlog = prior["matchlog"]
        print(f"  ! multi-season log unavailable ({e}); falling back to "
              f"{PRIOR_SEASON} only")

    DATA.mkdir(exist_ok=True)
    players.to_parquet(DATA / "players.parquet")
    matchlog.to_parquet(DATA / "matchlog.parquet")
    fixtures.to_parquet(DATA / "fixtures.parquet")

    audit = {
        "current_gw": 1,
        "n_players": len(players),
        "n_new_signings": int(players["is_new_signing"].sum()),
        "n_club_changes": int((players["prior_club"].notna()
                               & (players["prior_club"] != players["team"])).sum()),
        "n_pen_takers": int(players["is_pen_taker"].sum()),
        "n_no_pl_history": int(players["no_pl_history"].sum()),
        "prior_season_used": PRIOR_SEASON,
        "current_season": CUR_SEASON,
        "note": "Pre-season build: all *_now columns are correctly zero; "
               "projections run 100% on real prior-season data via the "
               "credibility blend. Injury flags unavailable pre-season.",
        "teams": sorted(players["team"].dropna().unique().tolist()),
    }
    (DATA / "audit.json").write_text(json.dumps(audit, indent=2, default=str))
    print(f"✓ wrote real players/matchlog/fixtures parquet")
    print(f"  {audit['n_new_signings']} players flagged as club changes / new to the league")
    return audit


def build_id_bridge(cur_players: pd.DataFrame, cur_season: str, prior_season: str,
                    force: bool = False) -> pd.DataFrame:
    """
    Bridge this season's fpl id to last season's fpl id via the stable `code`
    field (FPL's cross-season player code — the one identifier that survives a
    transfer, unlike `id`, which is re-issued between seasons' exports).

    Also carries last season's club and penalties_order across, which is what
    lets penalties.correct_prior_for_penalties strip out pen xG a player
    earned under his OLD club/order before re-crediting him under the new one.
    """
    d = build_prior.fetch_season(prior_season, force, require_gws=False)
    prior_players, prior_teams = d["players"], d["teams"]
    pid2short = dict(zip(prior_teams["id"], prior_teams["short_name"]))

    pp = prior_players[["code", "id", "team", "penalties_order"]].copy()
    pp["prior_fpl_id"] = pp["id"]
    pp["prior_team"] = pp["team"].map(pid2short)
    pp["penalties_order_prior"] = pp["penalties_order"]

    bridge = cur_players[["id", "code"]].copy()
    bridge["cur_fpl_id"] = bridge["id"]
    bridge = bridge.merge(
        pp[["code", "prior_fpl_id", "prior_team", "penalties_order_prior"]],
        on="code", how="left")
    return bridge[["cur_fpl_id", "prior_fpl_id", "prior_team", "penalties_order_prior"]]


if __name__ == "__main__":
    build()
