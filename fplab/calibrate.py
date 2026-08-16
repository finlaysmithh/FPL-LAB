"""
Weight fitting — the part that separates this from a spreadsheet.

You asked whether xG matters more than fixture, and whether a lower-xG player
with a soft fixture beats a higher-xG player with a hard one.  The honest
answer is: don't guess, fit it.

Method
------
Build a training row for every (player, gameweek) in history:

    features  = the xP components computed from data available BEFORE that GW
                (xG share, xA share, fixture lambda, CS prob, DefCon prob,
                 BPS rate, minutes probability, price, form, opponent DefWeak)
    target    = points ACTUALLY scored in that gameweek

Then fit a ridge regression.  Ridge rather than OLS because the components are
correlated (a good fixture raises xG, CS prob and bonus simultaneously), and
unregularised coefficients would swing wildly between seasons.

Validation must be FORWARD-CHAINING — train on GW1..n, test on GW n+1, walk
forward.  A random train/test split leaks future information through team form
and will make a bad model look excellent.

Read the fitted coefficients as answers to your question:
  * A high coefficient on xG_share means underlying attacking output dominates.
  * A high coefficient on opponent DefWeak means fixture swing dominates.
Empirically these differ sharply by position — fixture and clean-sheet terms
dominate for defenders, raw xG dominates for forwards.  Fit per position.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import StandardScaler

FEATURES = [
    "xg_fix",
    "xa_fix",
    "cs_prob",
    "defcon_prob",
    "bps90",
    "p60",
    "lam_for",
    "lam_against",
    "opp_def_weak",
    "price",
    "form5",
]


def fit_position_weights(
    train: pd.DataFrame,
    target: str = "points_next",
    alpha: float = 1.0,
) -> dict[str, dict]:
    """
    Fit one ridge model per position.  Returns coefficients in standardised
    units so they are directly comparable: the coefficient on xg_fix versus
    the coefficient on opp_def_weak tells you which signal actually moves
    points.
    """
    models = {}
    for pos, g in train.groupby("position"):
        X = g[FEATURES].fillna(0.0).values
        y = g[target].values
        sc = StandardScaler().fit(X)
        m = Ridge(alpha=alpha).fit(sc.transform(X), y)
        models[pos] = {
            "coef": dict(zip(FEATURES, m.coef_)),
            "intercept": float(m.intercept_),
            "n": len(g),
            "scaler_mean": sc.mean_.tolist(),
            "scaler_scale": sc.scale_.tolist(),
        }
    return models


def walk_forward_validate(
    data: pd.DataFrame,
    gw_col: str = "gw",
    min_train_gws: int = 8,
    alpha: float = 1.0,
) -> pd.DataFrame:
    """
    Forward-chaining validation.  For each gameweek g > min_train_gws, train on
    everything before g and predict g.  Reports MAE and Spearman rank
    correlation — rank matters more than absolute error, because the optimiser
    only cares about ordering.
    """
    from scipy.stats import spearmanr

    out = []
    gws = sorted(data[gw_col].unique())
    for g in gws[min_train_gws:]:
        tr = data[data[gw_col] < g]
        te = data[data[gw_col] == g]
        if len(tr) < 200 or te.empty:
            continue
        models = fit_position_weights(tr, alpha=alpha)
        preds, actual = [], []
        for pos, grp in te.groupby("position"):
            if pos not in models:
                continue
            m = models[pos]
            X = grp[FEATURES].fillna(0.0).values
            Xs = (X - np.array(m["scaler_mean"])) / np.array(m["scaler_scale"])
            p = Xs @ np.array([m["coef"][f] for f in FEATURES]) + m["intercept"]
            preds.extend(p)
            actual.extend(grp["points_next"].values)
        if len(preds) > 10:
            out.append(
                {
                    "gw": g,
                    "mae": mean_absolute_error(actual, preds),
                    "spearman": spearmanr(actual, preds).correlation,
                    "n": len(preds),
                }
            )
    return pd.DataFrame(out)


def component_weights_from_models(models: dict) -> dict:
    """
    Convert fitted ridge coefficients into the multiplicative component
    weights consumed by xpts.player_xp.  Normalised so the mean weight is 1,
    keeping xP on the FPL points scale rather than an arbitrary one.
    """
    mapping = {
        "goals": "xg_fix",
        "assists": "xa_fix",
        "clean_sheet": "cs_prob",
        "defcon": "defcon_prob",
        "bonus": "bps90",
        "appearance": "p60",
    }
    raw = {}
    for comp, feat in mapping.items():
        vals = [m["coef"].get(feat, 0.0) for m in models.values()]
        raw[comp] = float(np.mean(vals)) if vals else 1.0
    mean = np.mean([abs(v) for v in raw.values()]) or 1.0
    return {k: float(abs(v) / mean) for k, v in raw.items()}
