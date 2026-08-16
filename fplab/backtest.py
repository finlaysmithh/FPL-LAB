"""
Real backtest and weight calibration.

This is what separates the model from a spreadsheet: every coefficient is
fitted against what actually happened, and validated forward in time.

Data: the complete real 2025/26 season (29,757 player-gameweek rows from
vaastav/Fantasy-Premier-League, which archives FPL's own numbers).

Protocol
--------
For each gameweek g:
  * Build features using ONLY data available before g (rolling rates through
    g-1, plus the fixture's opponent ratings computed from matches before g).
  * Target: points ACTUALLY scored in g.
  * Train on gameweeks < g, predict g, walk forward.

Forward-chaining is mandatory. A random train/test split leaks the future
through team form and rolling rates, and will make a bad model look excellent.
Any FPL tool quoting an r² from a shuffled split is quoting a fantasy.

Metrics
-------
  MAE       average absolute points error (lower better)
  Spearman  RANK correlation — this is the metric that matters, because the
            optimiser only cares about ordering players, not about hitting
            their absolute score
  top-N     mean actual points of the N players the model ranked highest,
            versus the true best N. This is the closest thing to "would this
            have helped me pick a team".

The fitted per-position coefficients answer the question directly: does xG
matter more than fixture? Read the standardised coefficients.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import StandardScaler

from . import build_prior
from .sources import DATA

# `start_roll` is deliberately EXCLUDED: it correlates 0.983 with mins_roll,
# and including both split one real effect into +0.99 / -0.70 nonsense
# coefficients. Dropping it leaves accuracy unchanged (MAE 2.092 vs 2.091,
# Spearman 0.304 vs 0.305) while making every coefficient readable.
FEATURES = [
    "xg90_roll", "xa90_roll", "defcon90_roll", "bps90_roll",
    "mins_roll",
    "team_att", "opp_def", "was_home",
    "price", "form5",
]


def build_training_frame(season: str = "2025-26", halflife: float = 6.0) -> pd.DataFrame:
    """
    Turn the raw gameweek log into a supervised learning frame with strictly
    backward-looking features.
    """
    d = build_prior.fetch_season(season, require_gws=True)
    gw = d["gws"].copy()
    teams = d["teams"]
    gw = gw.sort_values(["element", "GW"])

    # Rolling, exponentially-weighted, SHIFTED so row g uses only < g.
    def ewm_shift(s, hl=halflife):
        return s.shift(1).ewm(halflife=hl, min_periods=1).mean()

    g = gw.groupby("element", group_keys=False)
    gw["mins_roll"] = g["minutes"].apply(ewm_shift)
    gw["start_roll"] = g["starts"].apply(ewm_shift)
    gw["form5"] = g["total_points"].apply(ewm_shift)

    # Per-90 rolling rates, guarding tiny denominators.
    for src, dst in [("expected_goals", "xg90_roll"), ("expected_assists", "xa90_roll"),
                     ("defensive_contribution", "defcon90_roll"), ("bps", "bps90_roll")]:
        per90 = gw[src] / gw["minutes"].replace(0, np.nan) * 90
        gw[dst] = per90.groupby(gw["element"]).apply(
            lambda s: s.shift(1).ewm(halflife=halflife, min_periods=1).mean()
        ).reset_index(level=0, drop=True)

    # Team strength through g-1, from real team xG.
    tm = (gw.groupby(["team", "GW"])
            .agg(txg=("expected_goals", "sum"))
            .reset_index()
            .sort_values(["team", "GW"]))
    tm["team_att"] = tm.groupby("team")["txg"].apply(
        lambda s: s.shift(1).ewm(halflife=8, min_periods=1).mean()
    ).reset_index(level=0, drop=True)
    lg = tm["team_att"].mean()
    tm["team_att"] = tm["team_att"] / lg

    # Opponent defensive weakness = xG they concede, through g-1.
    conc = (gw.groupby(["opponent_team", "GW"])
              .agg(cxg=("expected_goals", "sum")).reset_index()
              .sort_values(["opponent_team", "GW"]))
    conc["opp_def"] = conc.groupby("opponent_team")["cxg"].apply(
        lambda s: s.shift(1).ewm(halflife=8, min_periods=1).mean()
    ).reset_index(level=0, drop=True)
    conc["opp_def"] = conc["opp_def"] / conc["opp_def"].mean()

    gw = gw.merge(tm[["team", "GW", "team_att"]], on=["team", "GW"], how="left")
    gw = gw.merge(conc[["opponent_team", "GW", "opp_def"]],
                  on=["opponent_team", "GW"], how="left")

    gw["price"] = gw["value"] / 10.0
    gw["was_home"] = gw["was_home"].astype(int)
    gw["position"] = gw["position"].map(
        {"GK": "GK", "GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"})
    gw["points_next"] = gw["total_points"]

    keep = FEATURES + ["points_next", "GW", "position", "element", "name", "minutes"]
    out = gw[keep].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    # Only rows where the player actually featured — projecting a benched
    # player's score is the minutes model's job, not the points model's.
    return out[out["minutes"] > 0]


def walk_forward(data: pd.DataFrame, min_train_gw: int = 8,
                 alpha: float = 1.0, top_n: int = 20) -> tuple[pd.DataFrame, dict]:
    rows, models = [], {}
    gws = sorted(data["GW"].unique())
    for g in gws:
        if g <= min_train_gw:
            continue
        tr, te = data[data.GW < g], data[data.GW == g]
        if len(tr) < 300 or te.empty:
            continue
        preds, actual = [], []
        for pos, grp in te.groupby("position"):
            trp = tr[tr.position == pos]
            if len(trp) < 50:
                continue
            sc = StandardScaler().fit(trp[FEATURES])
            m = Ridge(alpha=alpha).fit(sc.transform(trp[FEATURES]), trp["points_next"])
            models[pos] = (m, sc)
            p = m.predict(sc.transform(grp[FEATURES]))
            preds.extend(p)
            actual.extend(grp["points_next"].values)
        if len(preds) < 30:
            continue
        preds, actual = np.array(preds), np.array(actual)
        order = np.argsort(-preds)
        rows.append({
            "gw": g,
            "mae": mean_absolute_error(actual, preds),
            "spearman": spearmanr(actual, preds).correlation,
            "top_n_actual": actual[order[:top_n]].mean(),
            "best_possible": np.sort(actual)[::-1][:top_n].mean(),
            "field_mean": actual.mean(),
            "n": len(preds),
        })
    return pd.DataFrame(rows), models


def fitted_coefficients(data: pd.DataFrame, alpha: float = 1.0) -> pd.DataFrame:
    """
    Standardised ridge coefficients per position, fitted on the full season.

    Because features are standardised, coefficients are directly comparable:
    a larger absolute value means that signal moves points more.
    """
    recs = []
    for pos, grp in data.groupby("position"):
        if len(grp) < 100:
            continue
        sc = StandardScaler().fit(grp[FEATURES])
        m = Ridge(alpha=alpha).fit(sc.transform(grp[FEATURES]), grp["points_next"])
        rec = {"position": pos, "n": len(grp)}
        rec.update(dict(zip(FEATURES, m.coef_.round(4))))
        recs.append(rec)
    return pd.DataFrame(recs).set_index("position")


def run(season: str = "2025-26", save: bool = True) -> dict:
    print(f"→ building supervised frame from real {season} gameweek data")
    data = build_training_frame(season)
    print(f"  {len(data)} player-gameweek rows with minutes > 0")

    print("→ walk-forward validation (train on <g, test on g)")
    results, _ = walk_forward(data)
    print(f"  validated across {len(results)} gameweeks")
    print(f"  MAE        {results['mae'].mean():.3f} points")
    print(f"  Spearman   {results['spearman'].mean():.3f} (rank correlation)")
    print(f"  top-20 picks averaged {results['top_n_actual'].mean():.2f} pts "
          f"vs field {results['field_mean'].mean():.2f} "
          f"(perfect hindsight {results['best_possible'].mean():.2f})")

    print("→ fitted standardised coefficients by position")
    coefs = fitted_coefficients(data)
    print(coefs.to_string())

    if save:
        results.to_csv(DATA / "backtest_results.csv", index=False)
        coefs.to_csv(DATA / "fitted_coefficients.csv")
        print(f"✓ wrote data/backtest_results.csv, data/fitted_coefficients.csv")
    return {"results": results, "coefficients": coefs}


if __name__ == "__main__":
    run()
