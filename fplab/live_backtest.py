"""
Walk-forward validation of the LIVE production engine — not a stand-in model.

`backtest.py` fits a separate Ridge regression on rolling features and has
never touched `blend.py`, `minutes.py` or `xpts.py`. Every accuracy number in
the README traced back to that Ridge model, not to the code that actually
generates a projection in the app. This file closes that gap: it calls
`ratings.team_ratings`, `blend.build_player_rates`, `minutes.estimate` and
`xpts.project` exactly as `pipeline.build_projections` does, but fed only the
data that would have been available BEFORE each real historical gameweek.

Method, one test season at a time (e.g. test=2025-26, prior=2024-25):

  1. Real prior-season team ratings and player rates — identical to what
     `build_real.py` computes for the live app today.
  2. For each gameweek g from `start_gw` to the season's last:
       - team ratings from real matches with GW < g, shrunk toward the prior
         exactly as `team_ratings(prior_ratings=...)` does live.
       - player "now" rates aggregated from real GW < g rows.
       - real per-gameweek start/minutes history through GW < g, run through
         the actual `minutes.estimate` function — the same call the live
         pipeline makes, not an approximation of it.
       - `xpts.project` on the real GW g fixture.
       - compared against real `total_points` for GW g.
  3. MAE, Spearman correlation and top-20-vs-field, exactly as `backtest.py`
     already reports, so the two numbers are directly comparable — one says
     what a different model would have done, this one says what THIS engine
     would have done.

Honest simplifications, stated plainly rather than hidden:
  - No live injury/status flags mid-backtest — vaastav's archive does not
    carry a reliable per-gameweek news feed, so every player is treated as
    available. This tests the STATISTICAL engine, not news-reactivity, which
    is exactly the same boundary the live app discloses pre-season.
  - The pre-season `minutes_guard` fringe/signing ceilings (minutes.py) are
    pre-season-specific and are not reapplied mid-season here — real observed
    starts via `minutes.estimate`'s decayed start_rate already captures "this
    player stopped starting" dynamically, which is if anything a MORE direct
    signal mid-season than a flat ceiling would be.
  - `prior_team_xg90` for new signings is computed from the prior club's real
    rating where the player was already in the PL the season before — a real
    improvement over the live pipeline's current flat 1.45 stub, and one this
    file's result should probably be fed back into.

Run:  python -m fplab.live_backtest [--seasons 2023-24,2024-25,2025-26] [--start-gw 4]
"""
from __future__ import annotations

import argparse
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import mean_absolute_error

from . import (build_prior, minutes as minutes_mod, pipeline, promoted,
               player_history, ratings, roles, simulate, xpts)
from .blend import build_player_rates
from .sources import DATA

warnings.filterwarnings("ignore")

POS_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


def _prior_side(prior_season: str):
    d = build_prior.fetch_season(prior_season, require_gws=True)
    matchlog = build_prior.team_match_log(d["gws"], d["teams"])
    team_ratings = ratings.team_ratings(matchlog)
    league_mu = float(matchlog["xg_for"].mean())
    player_rates = build_prior.player_prior_rates(d["players"], d["gws"], d["teams"])
    id2short = dict(zip(d["teams"]["id"], d["teams"]["short_name"]))
    return d, matchlog, team_ratings, league_mu, player_rates, id2short


def _bridge(test_players: pd.DataFrame, prior_players: pd.DataFrame,
           prior_id2short: dict, prior_rt: pd.DataFrame, league_mu: float) -> pd.DataFrame:
    """Cross-season id map via FPL's stable `code`, plus a REAL prior team xG90
    (fixes the live pipeline's current flat-1.45 stub for players with PL history)."""
    pp = prior_players[["code", "id", "team"]].copy()
    pp["prior_fpl_id"] = pp["id"]
    pp["prior_team"] = pp["team"].map(prior_id2short)
    pp["prior_team_xg90"] = pp["prior_team"].map(
        lambda t: league_mu * float(prior_rt.at[t, "att"]) if t in prior_rt.index else 1.45)

    bridge = test_players[["id", "code"]].rename(columns={"id": "cur_fpl_id"})
    out = bridge.merge(pp[["code", "prior_fpl_id", "prior_team", "prior_team_xg90"]],
                       on="code", how="left")
    # `code` is dropped: the caller merges this onto `meta`, which already
    # carries it, and two `code` columns become code_x/code_y — which silently
    # breaks every later join keyed on it.
    return out.drop(columns=["code"])


def decision_metrics(res: pd.DataFrame) -> dict:
    """
    Score the model on the DECISIONS a manager makes, not on its error term.

    MAE and rank correlation measure a regression. An FPL manager never submits
    a regression — they pick a captain, choose eleven from fifteen, and make
    one transfer. A model can improve its MAE by shading every projection
    toward the mean and get worse at all three. These metrics close that gap.

    Captaincy is the sharpest test in the game: one pick per week, doubled, and
    the difference between the best and an average choice is worth more than
    most transfers. It is reported against two reference points, because either
    alone is misleading — the PERFECT captain is unreachable and makes any
    model look bad, while the FIELD is a low bar that makes any model look
    good. What matters is where the model sits between them.
    """
    per_gw = []
    for g, d in res.groupby("gw"):
        if len(d) < 20:
            continue
        d = d.sort_values("xp", ascending=False)
        best = d["actual"].max()
        field = d["actual"].mean()
        row = {"gw": g, "capt_model": float(d["actual"].iloc[0]),
               "capt_best": float(best), "capt_field": float(field)}
        for n in (5, 10, 20):
            top = d.head(n)
            true_top = set(d.nlargest(n, "actual")["fpl_id"])
            row[f"hit{n}"] = len(set(top["fpl_id"]) & true_top) / n
            row[f"top{n}_pts"] = float(top["actual"].mean())
        per_gw.append(row)
    if not per_gw:
        return {}
    p = pd.DataFrame(per_gw)

    rmse = float(np.sqrt(np.mean((res["actual"] - res["xp"]) ** 2)))
    pearson = float(np.corrcoef(res["xp"], res["actual"])[0, 1])
    # Where the model's captain sits between an average player and the best
    # possible pick. 0% = no better than picking at random, 100% = perfect.
    span = p["capt_best"].mean() - p["capt_field"].mean()
    capture = ((p["capt_model"].mean() - p["capt_field"].mean()) / span
               if span > 0 else float("nan"))
    return {
        "rmse": round(rmse, 3),
        "pearson": round(pearson, 3),
        "capt_model": round(float(p["capt_model"].mean()), 2),
        "capt_best": round(float(p["capt_best"].mean()), 2),
        "capt_field": round(float(p["capt_field"].mean()), 2),
        "capt_capture": round(float(capture), 3),
        "hit5": round(float(p["hit5"].mean()), 3),
        "hit10": round(float(p["hit10"].mean()), 3),
        "hit20": round(float(p["hit20"].mean()), 3),
        "top5_pts": round(float(p["top5_pts"].mean()), 2),
        "top10_pts": round(float(p["top10_pts"].mean()), 2),
    }


def walk_forward(test_season: str, prior_season: str, start_gw: int = 4,
                 min_minutes: int = 1, keep_components: bool = False,
                 use_roles: bool = True, rating_exponent: float | None = None,
                 concentration: float | None = None,
                 sim_bonus: bool | None = None, sim_draws: int = 600,
                 use_history: bool = True,
                 freeze_ahead: int = 0) -> dict:
    """
    `use_roles` runs the squad-conservation step from `fplab.roles`, which the
    live pipeline applies and this backtest previously did not. Leaving it
    switchable is the point: a change to the engine that cannot be measured
    against the alternative is a change made on faith. Run
    `python -m fplab.live_backtest --ablate` to get both numbers.
    """
    d, _, prior_rt, league_mu_prior, prior_rates, prior_id2short = _prior_side(prior_season)
    prior_players = d["players"]

    test = build_prior.fetch_season(test_season, require_gws=True)
    bridge = _bridge(test["players"], prior_players, prior_id2short, prior_rt, league_mu_prior)

    id2short = dict(zip(test["teams"]["id"], test["teams"]["short_name"]))
    meta = test["players"][["id", "web_name", "first_name", "second_name", "team",
                            "element_type", "code", "now_cost"]].copy()
    meta["position"] = meta["element_type"].map(POS_MAP)
    meta["team_short"] = meta["team"].map(id2short)
    meta["full_name"] = meta["first_name"] + " " + meta["second_name"]
    meta["price"] = meta["now_cost"] / 10.0

    base = meta.merge(bridge, left_on="id", right_on="cur_fpl_id", how="left")
    base = base.merge(
        prior_rates.drop(columns=["team", "position", "full_name"], errors="ignore"),
        on="prior_fpl_id", how="left")
    for c in ("xg90_prior", "xa90_prior", "defcon90_prior", "bps90_prior", "mins_share_prior"):
        base[c] = base[c].fillna(0.0)
    base["is_new_signing"] = (base["prior_fpl_id"].isna()
                              | (base["prior_team"] != base["team_short"])).fillna(True)
    base["prior_league"] = "Premier League"
    base["prior_team_xg90"] = base["prior_team_xg90"].fillna(1.45)

    # ---- multi-season history, strictly before the test season -------------
    # Without this the backtest fed the engine ONE prior season and never
    # touched `player_history` — so the multi-season blend and the carried
    # chance-share, both of which the live app runs on, were measured by
    # nothing. Any change to that path would have scored as a no-op here
    # regardless of whether it worked.
    #
    # The season list is truncated below `test_season`, which is what keeps
    # this honest: predicting 2024-25 may use 2022-23 and 2023-24 and nothing
    # else. Leaking the test season in through the "history" would make every
    # subsequent number meaningless.
    if use_history:
        past = [s for s in player_history.SEASONS if s < test_season]
        if past:
            hist = player_history.blended_rates(past)
            hcols = {"xg90": "xg90_prior", "xa90": "xa90_prior",
                     "defcon90": "defcon90_prior", "bps90": "bps90_prior"}
            h = hist.rename(columns={k: f"_h_{v}" for k, v in hcols.items()})
            keep = ["code", "career_n90", "hist_seasons",
                    *[f"_h_{v}" for v in hcols.values()]]
            for c in ("xg_share", "xa_share", "team_xg90"):
                if c in h.columns:
                    keep.append(c)
            base = base.merge(h[keep], on="code", how="left")
            for src_pos, col in hcols.items():
                src = f"_h_{col}"
                use = base[src].notna()
                base.loc[use, col] = base.loc[use, src]
                base.drop(columns=[src], inplace=True)
            base = base.rename(columns={"xg_share": "xg_share_prior",
                                        "xa_share": "xa_share_prior"})
            if "team_xg90" in base.columns:
                base["prior_team_xg90"] = pd.to_numeric(
                    base["team_xg90"], errors="coerce").fillna(base["prior_team_xg90"])
                base = base.drop(columns=["team_xg90"])
    # `meta` carries FPL's numeric team id in `team`; the rest of the engine
    # expects the short code there. Drop the numeric one first or the rename
    # leaves two `team` columns and every lookup gets a Series.
    base = base.drop(columns=["team"]).rename(columns={"team_short": "team"})
    # 2024/25 introduced managers as element_type 5, which POS_MAP does not
    # cover, so their `position` is NaN and every scoring lookup keyed on it
    # raises. They are a separate asset class scored by different rules and the
    # xP engine has never modelled them — drop them rather than half-score them.
    base = base[base["position"].isin(("GK", "DEF", "MID", "FWD"))].reset_index(drop=True)

    gws = test["gws"].copy()
    max_gw = int(gws["GW"].max())
    all_current_teams = sorted(set(id2short.values()))

    rows = []
    for g in range(start_gw, max_gw + 1):
        # `freeze_ahead` steps the model's knowledge BACK without moving the
        # target: at 0 this is the normal one-week-ahead projection, at 4 the
        # engine is frozen as it stood five gameweeks earlier and still asked
        # about this one. That is what makes horizon error measurable — the
        # fixture advances, the information does not.
        seen = gws[gws["GW"] < g - freeze_ahead]
        if seen.empty:
            continue

        cur_matchlog = build_prior.team_match_log(seen, test["teams"])
        if cur_matchlog.empty:
            continue
        cur_rt = ratings.team_ratings(cur_matchlog, prior_ratings=prior_rt)
        cur_rt = promoted.reconcile(cur_rt, all_current_teams)
        league_mu = float(cur_matchlog["xg_for"].mean())
        team_xg90 = {t: league_mu * float(cur_rt.at[t, "att"]) for t in cur_rt.index}

        # `defensive_contribution` only exists in FPL's export from 2025/26, the
        # season the rule was introduced. Older archives are real data with the
        # column genuinely absent, so fill with zero and score the rules that
        # did exist — the same guard build_prior.player_prior_rates applies.
        # Without it every pre-2025/26 season died on a KeyError here.
        for _c in ("yellow_cards", "red_cards", "saves", "defensive_contribution"):
            if _c not in seen.columns:
                seen = seen.assign(**{_c: 0.0})
        now = seen.groupby("element").agg(
            minutes=("minutes", "sum"), xg=("expected_goals", "sum"),
            xa=("expected_assists", "sum"), defcon=("defensive_contribution", "sum"),
            bps=("bps", "sum"), yellow=("yellow_cards", "sum"),
            red=("red_cards", "sum"), saves=("saves", "sum"),
            assists_now=("assists", "sum"),
            xa_total_now=("expected_assists", "sum")).reset_index()
        n90 = (now["minutes"] / 90.0).clip(lower=0.001)
        now["n90_now"] = now["minutes"] / 90.0
        now["xg90_now"] = now["xg"] / n90
        now["xa90_now"] = now["xa"] / n90
        now["defcon90_now"] = now["defcon"] / n90
        now["bps90_now"] = now["bps"] / n90
        now["mins_share_now"] = (now["minutes"] / ((g - 1) * 90)).clip(upper=1.0)
        # Card and save rates, so fit_components can actually fit those two
        # weights instead of silently falling back to the default.
        now["yellow90"] = now["yellow"] / n90
        now["red90"] = now["red"] / n90
        now["saves90"] = now["saves"] / n90

        pf = base.merge(now, left_on="id", right_on="element", how="left")
        for c in ("n90_now", "xg90_now", "xa90_now", "defcon90_now", "bps90_now",
                  "mins_share_now", "yellow90", "red90", "saves90",
                  "assists_now", "xa_total_now"):
            pf[c] = pf[c].fillna(0.0)

        # Real minutes.estimate, fed real per-gameweek start/minute history —
        # the same function the live pipeline calls, not an approximation.
        hist = {pid: grp.sort_values("GW")[["starts", "minutes"]].to_dict("records")
               for pid, grp in seen.groupby("element")}
        est = []
        for _, p in pf.iterrows():
            h = minutes_mod.minutes_from_history(hist.get(p["id"], []))
            row = dict(p)
            row.update(h)
            e = minutes_mod.estimate(pd.Series(row), prior_mins_share=p["mins_share_prior"])
            est.append(e)
        est_df = pd.DataFrame(est)
        pf["p_play"] = est_df["p_play"].values
        pf["p_60"] = est_df["p_60"].values
        pf["mins_frac"] = est_df["mins_frac"].values

        if use_roles:
            # Squad conservation, exactly as pipeline.minutes_by_gameweek does
            # it live. No predicted XI exists mid-season — that is a pre-season
            # artefact — and no injury flags are available in this archive, so
            # this measures the conservation and concentration steps alone,
            # which is the honest scope of what can be tested here.
            mps_bt = pd.to_numeric(
                pd.Series([h.get("mins_per_start", np.nan)
                           for h in (minutes_mod.minutes_from_history(
                               hist.get(pid, [])) for pid in pf["id"])]),
                errors="coerce")
            alloc = roles.allocate(pf["mins_frac"] * 90.0, pf["team"],
                                   pf["position"], mins_per_start=mps_bt,
                                   # Minutes played SO FAR this season — the
                                   # evidence actually available before GW g.
                                   evidence_minutes=pf["n90_now"] * 90.0,
                                   **({} if concentration is None
                                      else {"concentration": concentration}))
            probs = roles.probabilities(alloc["mins_share"].values,
                                        nailed=alloc["nailed"].values)
            pf["mins_frac"] = alloc["mins_share"].values
            pf["p_play"] = probs["p_play"].values
            pf["p_60"] = probs["p_60"].values

        blended = build_player_rates(pf, team_xg90)
        blended["mins_share_blend"] = blended["mins_frac"]
        blended["fpl_id"] = blended["id"]
        blended["display_name"] = blended["web_name"]
        blended["provisional"] = blended.get("provisional", False)

        fx = pd.DataFrame([{"gw": g, "home": h, "away": a}
                          for h, a in zip(test["fixtures"]["team_h"].map(id2short),
                                          test["fixtures"]["team_a"].map(id2short))
                          if test["fixtures"] is not None])
        # fixtures.csv carries the real event number for this season.
        fx_g = test["fixtures"][test["fixtures"]["event"] == g]
        fx = pd.DataFrame({"gw": g, "home": fx_g["team_h"].map(id2short),
                          "away": fx_g["team_a"].map(id2short)})
        ftab = ratings.fixture_lambdas(
            fx, cur_rt, league_mu,
            **({} if rating_exponent is None else {'exponent': rating_exponent}))
        if ftab.empty:
            continue

        proj = xpts.project(blended, ftab, team_xg90, [g])
        proj = proj[proj["n_fix"] > 0]

        use_sim_bonus = (pipeline.SIM_BONUS_REPLACES_CURVE
                         if sim_bonus is None else sim_bonus)
        if use_sim_bonus and len(proj):
            # The match-level bonus contest, run on exactly the information
            # available before this gameweek. The shipped model uses it, so the
            # backtest has to as well or it is validating a different engine.
            s = proj.copy()
            # `pf` can carry a player twice after the prior-season merge, and a
            # non-unique index makes every .map() below raise.
            mm = pf.drop_duplicates(subset="id").set_index("id")
            s["defcon90"] = s["fpl_id"].map(mm["defcon90_prior"]).fillna(0.0)
            s["bps_base"] = (s["fpl_id"].map(mm["bps90_prior"]).fillna(0.0)
                             * pipeline.BPS_RESIDUAL)
            # Mean over the club's fixtures: a double gameweek puts a team in
            # `ftab` twice, and indexing by label would return a Series.
            ftx = ftab.groupby("team")["cs_prob"].mean()
            s["cs_prob"] = s["team"].map(ftx).fillna(0.25).astype(float)
            mk = {}
            for _, f in fx.iterrows():
                tag = f"{f['home']}-{f['away']}"
                mk[f["home"]] = tag
                mk[f["away"]] = tag
            s["match_key"] = [mk.get(t) for t in s["team"]]
            s["p_play"] = s["fpl_id"].map(mm["p_play"]).fillna(0.0)
            s["p_60"] = s["fpl_id"].map(mm["p_60"]).fillna(0.0)
            s["mins_share"] = s["fpl_id"].map(mm["mins_frac"]).fillna(0.0)
            s = s[s["match_key"].notna()]
            sim = simulate.simulate_gameweek(s, g, n_sims=sim_draws)
            if len(sim):
                bmap = dict(zip(sim["fpl_id"], sim["e_bonus"]))
                new_b = proj["fpl_id"].map(bmap)
                have = new_b.notna()
                proj.loc[have, "xp"] = (proj.loc[have, "xp"]
                                        - proj.loc[have, "xp_bonus"].fillna(0.0)
                                        + new_b[have])
                proj.loc[have, "xp_bonus"] = new_b[have]

        actual = gws[gws["GW"] == g].groupby("element")["total_points"].sum()
        real_minutes = gws[gws["GW"] == g].groupby("element")["minutes"].sum()

        comp_cols = [c for c in proj.columns if c.startswith("xp_")]
        for _, r in proj.iterrows():
            pid = r["fpl_id"]
            if pid not in actual.index or real_minutes.get(pid, 0) < min_minutes:
                continue
            rec = {"gw": g, "fpl_id": pid, "xp": r["xp"], "actual": actual.at[pid],
                   "position": r.get("position"),
                   # Carried so a squad can actually be BUILT from this frame:
                   # scoring a policy needs price and club to enforce budget
                   # and the three-per-club cap, not just the projection.
                   "price": float(r.get("price", 0.0) or 0.0),
                   "team": r.get("team"),
                   "display_name": r.get("display_name", str(pid)),
                   "exp_mins": float(r.get("exp_mins_gw", 0.0) or 0.0)}
            if keep_components:
                rec.update({c: float(r[c]) for c in comp_cols})
            rows.append(rec)

    res = pd.DataFrame(rows)
    if res.empty:
        return {"season": test_season, "n": 0}

    mae = mean_absolute_error(res["actual"], res["xp"])
    corr = spearmanr(res["xp"], res["actual"]).correlation
    top20 = (res.sort_values("xp", ascending=False).groupby("gw").head(20))
    field = res.groupby("gw")["actual"].mean()
    top20_avg = top20["actual"].mean()
    field_avg = field.mean()
    ratio = res["xp"].mean() / res["actual"].mean() if res["actual"].mean() else float("nan")

    out = {
        "season": test_season, "prior_season": prior_season,
        "n": len(res), "n_gws": res["gw"].nunique(),
        "mae": round(float(mae), 3), "spearman": round(float(corr), 3),
        "top20_avg": round(float(top20_avg), 2), "field_avg": round(float(field_avg), 2),
        "calibration_ratio": round(float(ratio), 3),
        "model_mean": round(float(res["xp"].mean()), 3),
        "real_mean": round(float(res["actual"].mean()), 3),
    }
    out.update(decision_metrics(res))
    # Early-season metrics, reported separately. A change to the PRIOR is a
    # change to what the model believes before it has seen anything, and by
    # GW20 the credibility weight n/(n+K) has handed most of the decision to
    # observed data — so a full-season average dilutes exactly the effect such
    # a change is trying to have. GW4-10 is where the prior still dominates.
    early = res[res["gw"] <= 10]
    if len(early) > 200:
        em = decision_metrics(early)
        out["early_mae"] = round(float(mean_absolute_error(
            early["actual"], early["xp"])), 3)
        out["early_spearman"] = round(float(
            spearmanr(early["xp"], early["actual"]).correlation), 4)
        out["early_capt"] = em.get("capt_model")
        out["early_hit20"] = em.get("hit20")
    if keep_components:
        out["frame"] = res
    return out


def horizon_decay(seasons: list[str] | None = None, max_ahead: int = 9,
                  start_gw: int = 8) -> pd.DataFrame:
    """
    How fast does a projection go stale?

    Task D's premise — GW1-3 is a forecast, GW4-8 a scenario, GW9+ a
    fixture-planning aid — is a claim about ERROR GROWTH, and error growth is
    measurable. `freeze_ahead=t` holds the engine's knowledge t gameweeks in
    the past while still asking it about the current fixture, so t+1 is the
    forecast horizon. Scoring each t against what actually happened gives the
    decay curve the app's confidence weight should be fitted to, instead of a
    number asserted in a comment.
    """
    pairs = {"2023-24": "2022-23", "2024-25": "2023-24", "2025-26": "2024-25"}
    seasons = seasons or list(pairs)
    rows = []
    for s in seasons:
        prior = pairs.get(s)
        if not prior:
            continue
        for t in range(max_ahead + 1):
            # start_gw rises with t so every horizon is scored on the same
            # stretch of the season; otherwise a long horizon would be judged
            # only on later gameweeks and the comparison would be confounded.
            r = walk_forward(s, prior, start_gw=start_gw + t, freeze_ahead=t)
            if not r.get("n"):
                continue
            rows.append({"season": s, "ahead": t + 1, "mae": r["mae"],
                         "spearman": r["spearman"], "n": r["n"],
                         "capt": r.get("capt_model"), "hit20": r.get("hit20")})
            print(f"  {s} horizon {t+1:2d}: MAE {r['mae']:.3f}  "
                  f"rho {r['spearman']:.4f}  n={r['n']}")
    return pd.DataFrame(rows)


def run(seasons: list[str] | None = None, start_gw: int = 4) -> list[dict]:
    pairs = {"2023-24": "2022-23", "2024-25": "2023-24", "2025-26": "2024-25"}
    seasons = seasons or list(pairs)
    out = []
    for s in seasons:
        prior = pairs.get(s)
        if not prior:
            print(f"  {s}: no known prior season pairing, skipped")
            continue
        print(f"→ walk-forward {s} (prior {prior}), from GW{start_gw}")
        r = walk_forward(s, prior, start_gw=start_gw)
        if r.get("n", 0) == 0:
            print(f"  {s}: no data resolved, skipped")
            continue
        print(f"  n={r['n']} appearances across {r['n_gws']} gameweeks")
        print(f"  MAE {r['mae']}  Spearman {r['spearman']}  calibration {r['calibration_ratio']}")
        print(f"  top-20 picks {r['top20_avg']} vs field {r['field_avg']}")
        # The four numbers every engine change is judged on. rho and MAE
        # describe the regression; captain points and hit@20 describe the
        # decisions, and a change that improves one pair while damaging the
        # other is not an improvement — it is a trade that has to be argued
        # for explicitly rather than hidden behind a single headline metric.
        print(f"  captain {r.get('capt_model')} pts "
              f"(field {r.get('capt_field')}, perfect {r.get('capt_best')}, "
              f"capture {r.get('capt_capture')})")
        print(f"  hit@20 {r.get('hit20')}   hit@10 {r.get('hit10')}   "
              f"hit@5 {r.get('hit5')}")
        out.append(r)

    if out:
        print(f"\n{'season':9s} {'rho':>7s} {'MAE':>7s} {'capt':>7s} {'hit@20':>7s}")
        for r in out:
            print(f"{r['season']:9s} {r['spearman']:7.4f} {r['mae']:7.3f} "
                  f"{r.get('capt_model', float('nan')):7.2f} "
                  f"{r.get('hit20', float('nan')):7.3f}")

    DATA.mkdir(exist_ok=True)
    import json
    (DATA / "live_backtest.json").write_text(json.dumps(out, indent=2))
    print(f"\n✓ wrote data/live_backtest.json — {len(out)} season(s)")
    return out


def ablate(seasons: list[str] | None = None, start_gw: int = 4) -> None:
    """
    Measure the squad-conservation and rating-exponent changes against the
    engine without them.

    Read the result with the regime in mind. Conservation exists to fix squads
    whose expected minutes do not add up to a football team, and mid-season —
    the only period this backtest can cover — they nearly do: `minutes.estimate`
    has real observed start rates by then, and clubs sum to 1.01-1.26x of the
    921.8-minute budget. Pre-season, which is when the app is actually used for
    a wildcard or an initial squad, they sum to 0.72-1.62x. So this table
    measures conservation where it has least to correct, and a roughly neutral
    result here is the expected finding rather than a disappointing one.
    """
    pairs = {"2023-24": "2022-23", "2024-25": "2023-24", "2025-26": "2024-25"}
    seasons = seasons or ["2024-25", "2025-26"]
    variants = [
        ("baseline (no conservation)", dict(use_roles=False, rating_exponent=1.0)),
        ("+ squad conservation", dict(use_roles=True, rating_exponent=1.0)),
        ("+ rating exponent 1.10", dict(use_roles=True, rating_exponent=1.10)),
    ]
    print(f"{'season':9s} {'variant':30s} {'MAE':>6s} {'Spearman':>9s} "
          f"{'calib':>6s} {'top20':>6s}")
    for s in seasons:
        prior = pairs.get(s)
        if not prior:
            continue
        for label, kw in variants:
            r = walk_forward(s, prior, start_gw=start_gw, **kw)
            print(f"{s:9s} {label:30s} {r['mae']:6.3f} {r['spearman']:9.4f} "
                  f"{r['calibration_ratio']:6.3f} {r['top20_avg']:6.2f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Walk-forward validate the LIVE xP engine")
    ap.add_argument("--seasons", default="")
    ap.add_argument("--start-gw", type=int, default=4)
    ap.add_argument("--ablate", action="store_true",
                    help="compare with and without squad conservation")
    a = ap.parse_args()
    seasons = [s.strip() for s in a.seasons.split(",") if s.strip()] or None
    if a.ablate:
        ablate(seasons, a.start_gw)
    else:
        run(seasons, a.start_gw)
