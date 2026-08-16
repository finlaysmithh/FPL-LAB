"""Fit expected bonus against a player's BPS RATE, not a single match's BPS.

The previous fit was correct about the wrong quantity. It mapped one match's BPS
to that match's bonus, which is a steeply convex curve — then the engine fed it
each player's *average* BPS. Evaluating a convex function at the mean is not the
mean of the function (Jensen's inequality), and it under-counted badly: the model
awarded 0.024 bonus per starter against a real 0.294, twelve times too small.

Bonus is a tail event. A player averaging 15 BPS earns his bonus in the games he
hits 35, not in the average game. The model's mean BPS was right (16.3 vs a real
15.1) while its implied spread was not (p90 21.3 vs a real 31.0), so the tail —
where all the bonus lives — was missing.

The fix is to fit the quantity the engine actually needs: given a player's BPS per
90, how much bonus does he average per appearance? Fitting on player-season
aggregates integrates over each player's own match-to-match distribution, so the
tail is inside the fitted curve instead of being thrown away before it.

Run:  python -m fplab.fit_bonus
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit

from .sources import DATA


def bonus_curve(bps90, amp, centre, scale):
    """Expected bonus per appearance for a player whose rate is `bps90`."""
    return amp / (1.0 + np.exp(-(bps90 - centre) / scale))


def _player_table(season: str, min_apps: int = 10) -> pd.DataFrame:
    gws = pd.read_csv(DATA / f"vaastav_{season}" / "gws" / "merged_gw.csv",
                      usecols=["element", "name", "bps", "bonus", "minutes"])
    played = gws[gws["minutes"] >= 60]
    g = played.groupby("element").agg(
        bps90=("bps", "mean"),          # per appearance ~ per 90 for 60+ min games
        bonus=("bonus", "mean"),
        apps=("bonus", "size"))
    return g[g.apps >= min_apps]


def fit(season: str = "2025-26", min_apps: int = 10) -> dict:
    g = _player_table(season, min_apps)
    x = g.bps90.to_numpy(float)
    y = g.bonus.to_numpy(float)

    (amp, centre, scale), _ = curve_fit(
        bonus_curve, x, y, p0=[1.5, 25.0, 6.0],
        bounds=([0.2, 5.0, 1.0], [4.0, 60.0, 30.0]), maxfev=40000)

    pred = bonus_curve(x, amp, centre, scale)
    return {
        "amp": round(float(amp), 3),
        "centre": round(float(centre), 2),
        "scale": round(float(scale), 2),
        "n_players": int(len(g)),
        "mean_real": round(float(y.mean()), 4),
        "mean_fit": round(float(pred.mean()), 4),
        "corr": round(float(np.corrcoef(pred, y)[0, 1]), 3),
        "mae": round(float(np.abs(pred - y).mean()), 4),
    }


if __name__ == "__main__":
    r = fit()
    print(f"fitted on {r['n_players']} players with 10+ starts, 2025-26")
    print(f"  amp={r['amp']}  centre={r['centre']}  scale={r['scale']}")
    print(f"  mean bonus/appearance: real {r['mean_real']}  fitted {r['mean_fit']}")
    print(f"  corr {r['corr']}   MAE {r['mae']}")
    print("\n  bonus per appearance at a given BPS/90 rate:")
    for v in (10, 15, 20, 25, 30, 35):
        print(f"    {v:3d} BPS/90 -> {bonus_curve(v, r['amp'], r['centre'], r['scale']):.3f}")
