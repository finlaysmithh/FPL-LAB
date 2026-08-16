"""
Fit the nine multiplicative component weights against real season history.

`config.DEFAULT_COMPONENT_WEIGHTS` has always been hand-set (goals 0.97,
assists 0.93, everything else 1.00) and nothing ever replaced it. There IS a
`calibrate.component_weights_from_models`, but it is not the right tool and is
deliberately not wired in here: it reads coefficients out of a Ridge model
fitted on a DIFFERENT feature set (`xg_fix`, `cs_prob`, `bps90`, `price`,
`form5`, ...), standardised, with an intercept. Those coefficients are not on
the same scale as the point contributions `xpts.player_xp` emits, so rescaling
them to mean 1 produces numbers that look like weights but do not multiply the
components correctly.

The direct approach is both simpler and correct. The engine already decomposes
every projection into nine additive components that sum to xP:

    xp = w_app*appearance + w_goals*goals + ... + w_cards*cards

Run the LIVE engine walk-forward over a real season (fplab.live_backtest),
collect those components per player-gameweek alongside the points actually
scored, and regress actual on components with no intercept. The fitted
coefficients ARE the weights, by construction — each one answers "what should
this component be multiplied by so the total matches reality".

Constraints applied, and why:
  * no intercept — the weights must explain the points, not absorb a constant
  * non-negative — a negative weight would mean a component that earns FPL
    points reduces the projection, which is never a calibration result, only
    a collinearity artefact
  * `cards` and `conceded` are negative contributions already, so they are
    fitted on their absolute value and the sign is restored afterwards

Run:  python -m fplab.fit_components [--season 2025-26] [--start-gw 6]
"""
from __future__ import annotations

import argparse
import json
import warnings

import numpy as np
import pandas as pd
from scipy.optimize import lsq_linear

from . import live_backtest
from .sources import DATA

warnings.filterwarnings("ignore")

COMPONENTS = [
    ("appearance", "xp_appearance"),
    ("goals", "xp_goals"),
    ("assists", "xp_assists"),
    ("clean_sheet", "xp_cs"),
    ("defcon", "xp_defcon"),
    ("bonus", "xp_bonus"),
    ("saves", "xp_saves"),
    ("conceded", "xp_conceded"),
    ("cards", "xp_cards"),
]

# A component that barely fires in the sample cannot be fitted responsibly —
# its weight would be driven by a handful of rows. Below this share of total
# absolute contribution, keep the existing default instead of inventing one.
MIN_SIGNAL = 0.002

# Calibration weights are corrections, not free parameters — a component that
# encodes a real FPL scoring rule cannot legitimately be scaled to zero or
# doubled. Bounds plus a ridge pull toward 1.0 keep the fit honest under the
# heavy collinearity between components.
MIN_W, MAX_W = 0.6, 1.4
RIDGE_TOWARD_ONE = 0.35

# Appearance is deliberately NOT fitted. The backtest scores only players who
# actually featured, so the sample is conditioned on appearing — fitting a
# weight against it would bake that selection in and undo the rotation hedging
# on purpose. Left at 1.0; the hedging is a feature, not a bias.
PINNED = {"appearance": 1.0}


def fit(seasons: str | list[str] = "2025-26", prior: str | None = None,
        start_gw: int = 6) -> dict:
    """Fit across one or more seasons. More than one is strongly preferred —
    a single season overfits that season's scoring quirks (2025/26 introduced
    DefCon, for instance), and the weights are meant to be structural."""
    pairs = {"2023-24": "2022-23", "2024-25": "2023-24", "2025-26": "2024-25"}
    if isinstance(seasons, str):
        seasons = [seasons]

    frames = []
    for s in seasons:
        pr = prior or pairs.get(s)
        if not pr:
            print(f"  {s}: no prior season known, skipped")
            continue
        print(f"→ walk-forward over {s} (prior {pr})")
        try:
            r = live_backtest.walk_forward(s, pr, start_gw=start_gw, keep_components=True)
        except Exception as e:
            print(f"  {s}: failed ({type(e).__name__}: {e}) — skipped")
            continue
        fr = r.get("frame")
        if fr is None or fr.empty:
            print(f"  {s}: no rows")
            continue
        fr = fr.copy(); fr["season"] = s
        frames.append(fr)
        print(f"  {len(fr)} rows")
    if not frames:
        raise RuntimeError("no season produced usable rows")
    df = pd.concat(frames, ignore_index=True)
    season = ", ".join(seasons)
    print(f"  {len(df)} player-gameweek rows across {len(frames)} season(s)")

    present = [(name, col) for name, col in COMPONENTS if col in df.columns]
    X = df[[c for _, c in present]].fillna(0.0).to_numpy(float)
    y = df["actual"].to_numpy(float)

    # Negative contributions are fitted on magnitude so NNLS stays valid; the
    # sign lives in the component itself, not in its weight.
    signs = np.sign(np.where(np.abs(X).sum(axis=0) > 0, X.sum(axis=0), 1.0))
    signs[signs == 0] = 1.0
    Xa = X * signs

    share = np.abs(X).sum(axis=0) / max(np.abs(X).sum(), 1e-9)

    # Unconstrained least squares is the wrong tool here and produces nonsense:
    # every component scales with minutes and quality, so they are badly
    # collinear. An unconstrained NNLS fit piled weight onto `appearance`
    # (2.00) and zeroed `bonus`, `defcon` and `conceded` outright — an obvious
    # artefact, since those components demonstrably earn real FPL points.
    #
    # These weights are CALIBRATION CORRECTIONS on top of components that
    # already encode FPL's real scoring rules, not free parameters. So the fit
    # is ridge-regularised toward 1.0 and bounded to [MIN_W, MAX_W]: it may
    # correct a systematic bias, it may not rewrite the scoring system.
    lam = float(RIDGE_TOWARD_ONE) * max(len(y), 1) ** 0.5
    n_c = Xa.shape[1]
    Xr = np.vstack([Xa, lam * np.eye(n_c)])
    yr = np.concatenate([y, lam * np.ones(n_c)])
    coef = lsq_linear(Xr, yr, bounds=(MIN_W, MAX_W)).x

    weights, notes = {}, {}
    from .config import DEFAULT_COMPONENT_WEIGHTS
    for i, (name, col) in enumerate(present):
        if name in PINNED:
            weights[name] = PINNED[name]
            notes[name] = "pinned — sample conditions on appearing, so not fittable here"
        elif share[i] < MIN_SIGNAL:
            weights[name] = DEFAULT_COMPONENT_WEIGHTS.get(name, 1.0)
            notes[name] = f"too little signal ({share[i]*100:.2f}% of contribution) — default kept"
        else:
            weights[name] = round(float(coef[i]), 3)
            notes[name] = f"fitted on {share[i]*100:.1f}% of total contribution"
    for name, _ in COMPONENTS:
        weights.setdefault(name, DEFAULT_COMPONENT_WEIGHTS.get(name, 1.0))

    fitted_total = float((Xa @ coef).mean())
    return {
        "season": season, "n": int(len(df)),
        "weights": weights, "notes": notes,
        "model_mean_before": round(float(df["xp"].mean()), 3),
        "model_mean_after": round(fitted_total, 3),
        "real_mean": round(float(y.mean()), 3),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Fit xP component weights on real history")
    ap.add_argument("--seasons", default="2024-25,2025-26",
                    help="comma-separated; more than one avoids overfitting a single season")
    ap.add_argument("--start-gw", type=int, default=6)
    a = ap.parse_args()
    res = fit([s.strip() for s in a.seasons.split(",") if s.strip()], start_gw=a.start_gw)

    print(f"\nFITTED COMPONENT WEIGHTS ({res['n']} player-gameweeks, {res['season']})")
    for k, v in res["weights"].items():
        print(f"  {k:12s} {v:6.3f}   {res['notes'].get(k, '')}")
    print(f"\n  mean projection before {res['model_mean_before']}"
          f"  after {res['model_mean_after']}  real {res['real_mean']}")

    DATA.mkdir(exist_ok=True)
    out = DATA / "component_weights.json"
    out.write_text(json.dumps(res["weights"], indent=2))
    print(f"\n✓ wrote {out}")
    print("\n  BEFORE SHIPPING THESE: check them against all-1.0 on the same")
    print("  sample. Fitted weights have already been measured as WORSE once —")
    print("  the fit runs mid-season on players who featured, while the app")
    print("  projects pre-season for everyone, and weights do not transfer")
    print("  across that gap. Delete this file to fall back to 1.0.")
