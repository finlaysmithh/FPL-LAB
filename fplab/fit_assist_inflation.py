"""Fit the per-player assist-inflation multiplier, and the weight it deserves.

FPL pays for assists that Opta's xA never counts: a won penalty that is scored,
a shot parried to a team-mate, a deflection, a second ball. League-wide that is
worth ~1.38 assists per 1.0 xA, and `config.FPL_ASSIST_INFLATION` carries it as
one constant per position.

The question this module answers is whether a PLAYER'S OWN inflation is a trait
or noise. Measured year-over-year on players with 900+ minutes and 3+ xG in both
seasons, the assist ratio A/xA repeats:

    assist ratio A/xA        r = +0.249     <- a real, weak trait
    assists above xA per 90  r = +0.203
    finishing above xG /90   r = +0.051     <- noise; deliberately NOT modelled
    xG per 90 (control)      r = +0.803

Two things follow, and both matter.

First, the RATIO is the better parameterisation. The difference form (assists
above xA per 90) is the more obvious way to write it and the less stable one —
its per-pair r swings 0.096-0.269 against the ratio's steady 0.204-0.260 — because
a difference conflates "converts chances into FPL assists at a high rate" with
"creates a lot of chances". The ratio is also what the engine needs, since the
correction enters as a multiplier.

Second, r ~ 0.25 is the whole credibility budget. For a test-retest reliability
r, the minimum-MSE shrinkage toward the population mean IS r, so a player with a
full season of evidence has earned a quarter of the distance from the positional
constant to his own ratio, and no more. `select_weight` re-derives that number
out-of-sample rather than taking it on trust.

DATA NOTE — 2022-23 is only usable from GW16. FPL published no expected_goals or
expected_assists before then, so a full-season 2022-23 total divides 38 games of
goals by 22 games of xG. Left uncorrected the league ratio reads A/xA 2.11 and
G/xG 1.42 (against ~1.38 / ~0.98 in every other season), and Erling Haaland's
famous +18.5 goals above xG that season shrinks to +0.5 once both sides of the
comparison cover the same matches. Every table here restricts that season
accordingly.

Run:  python -m fplab.fit_assist_inflation
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from scipy.stats import pearsonr

from .config import FPL_ASSIST_INFLATION
from .sources import DATA

# Completed seasons with usable expected-assist data.
SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"]

# FPL published no xG/xA before GW16 of 2022-23. Totals for that season must be
# taken over the same window as the expected numbers or the ratio is nonsense.
FIRST_GW = {"2022-23": 16}

POS_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}

# Positional prior shrinkage, in xA. A position is trusted to speak for itself
# once it has ~100 xA of evidence; below that it is pulled toward the league
# ratio. This is the same constant the hand-fitted FPL_ASSIST_INFLATION comment
# describes, kept so the refit is comparable to the number it replaces.
POS_PRIOR_K = 100.0


def season_table(season: str) -> pd.DataFrame:
    """Per-player season totals: minutes, goals/assists and their expected counterparts."""
    gw = pd.read_csv(
        DATA / f"vaastav_{season}" / "gws" / "merged_gw.csv",
        usecols=["GW", "element", "name", "minutes", "assists", "goals_scored",
                 "expected_assists", "expected_goals"])
    gw = gw[gw["GW"] >= FIRST_GW.get(season, 0)]
    agg = gw.groupby("element").agg(
        minutes=("minutes", "sum"), assists=("assists", "sum"),
        goals=("goals_scored", "sum"), xa=("expected_assists", "sum"),
        xg=("expected_goals", "sum"), name=("name", "first")).reset_index()

    raw = pd.read_csv(DATA / f"vaastav_{season}" / "players_raw.csv",
                      usecols=["id", "code", "element_type"])
    agg = agg.merge(raw, left_on="element", right_on="id", how="left")
    agg["position"] = agg["element_type"].map(POS_MAP)
    agg["n90"] = agg["minutes"] / 90.0
    agg["season"] = season
    return agg


def positional_priors(tables: dict[str, pd.DataFrame], min_minutes: int = 450) -> dict:
    """Assists-per-xA by position, shrunk toward the league ratio by sample size."""
    allp = pd.concat(tables.values())
    allp = allp[allp["minutes"] >= min_minutes]
    league = float(allp["assists"].sum() / allp["xa"].sum())

    out = {}
    for pos, g in allp.groupby("position"):
        xa, a = float(g["xa"].sum()), float(g["assists"].sum())
        raw = a / xa if xa > 0 else league
        w = xa / (xa + POS_PRIOR_K)
        out[pos] = {"raw": round(raw, 3), "xa": round(xa, 1), "assists": int(a),
                    "shrunk": round(w * raw + (1 - w) * league, 3), "w": round(w, 3)}
    return {"league": round(league, 3), "by_position": out}


def _pairs(tables: dict[str, pd.DataFrame], min_minutes: int = 900,
           min_xg: float = 3.0) -> pd.DataFrame:
    """Consecutive-season player pairs, gated on a real sample in BOTH seasons.

    2022-23 covers only ~22 matches here, so its gates are halved rather than
    excluding the season outright.
    """
    frames = []
    for a, b in zip(SEASONS, SEASONS[1:]):
        A, B = tables[a], tables[b]
        m = A.merge(B, on="code", suffixes=("_1", "_2"))
        scale_a = 0.5 if a in FIRST_GW else 1.0
        scale_b = 0.5 if b in FIRST_GW else 1.0
        m = m[(m["minutes_1"] >= min_minutes * scale_a)
              & (m["minutes_2"] >= min_minutes * scale_b)
              & (m["xg_1"] >= min_xg * scale_a) & (m["xg_2"] >= min_xg * scale_b)]
        m["pair"] = f"{a} -> {b}"
        frames.append(m)
    return pd.concat(frames, ignore_index=True)


def persistence(tables: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Year-over-year correlation of each candidate signal."""
    p = _pairs(tables)
    metrics = {
        "assist ratio A/xA": (p["assists_1"] / p["xa_1"].clip(lower=1.0),
                              p["assists_2"] / p["xa_2"].clip(lower=1.0)),
        "assists above xA /90": ((p["assists_1"] - p["xa_1"]) / p["n90_1"],
                                 (p["assists_2"] - p["xa_2"]) / p["n90_2"]),
        "finishing above xG /90": ((p["goals_1"] - p["xg_1"]) / p["n90_1"],
                                   (p["goals_2"] - p["xg_2"]) / p["n90_2"]),
        "xG/90 (control)": (p["xg_1"] / p["n90_1"], p["xg_2"] / p["n90_2"]),
    }
    rows = []
    for name, (x, y) in metrics.items():
        rec = {"metric": name, "n": len(p), "pooled_r": round(float(pearsonr(x, y)[0]), 3)}
        for pair, g in p.groupby("pair"):
            i = p["pair"] == pair
            rec[pair] = round(float(pearsonr(x[i], y[i])[0]), 3)
        rows.append(rec)
    return pd.DataFrame(rows).set_index("metric")


def multiplier(assists: float, xa: float, position: str,
               credibility: float, k: float,
               priors: dict[str, float] | None = None) -> float:
    """The shipped rule, kept here so the fit and the engine cannot drift apart.

    Mirrors `blend.assist_multiplier`; see that function for the reasoning.
    """
    priors = priors or FPL_ASSIST_INFLATION
    prior = priors.get(position, 1.33)
    if xa <= 0:
        return prior
    own = float(np.clip(assists / xa, 0.0, 4.0))
    w = credibility * (xa / (xa + k))
    return (1 - w) * prior + w * own


def select_weight(tables: dict[str, pd.DataFrame], priors: dict[str, float],
                  grid_w=None, grid_k=None) -> dict:
    """Choose the credibility ceiling out-of-sample.

    Season 1 supplies the multiplier; season 2 is the held-out truth. The error
    scored is on ASSISTS predicted from that season's real xA — exactly the
    quantity `xpts.player_xp` multiplies — so a weight only wins here if it
    would have made the engine's assist points more accurate, on players and
    seasons the multiplier was not fitted on.
    """
    grid_w = np.arange(0.0, 1.01, 0.05) if grid_w is None else grid_w
    grid_k = [2.0, 4.0, 6.0, 8.0] if grid_k is None else grid_k
    p = _pairs(tables)

    rows = []
    for k in grid_k:
        for w in grid_w:
            mult = np.array([
                multiplier(a, xa, pos, w, k, priors)
                for a, xa, pos in zip(p["assists_1"], p["xa_1"], p["position_1"])])
            pred = mult * p["xa_2"].to_numpy(float)
            err = pred - p["assists_2"].to_numpy(float)
            rows.append({"k": k, "w": round(float(w), 3),
                         "mae": float(np.abs(err).mean()),
                         "rmse": float(np.sqrt((err ** 2).mean())),
                         "bias": float(err.mean())})
    grid = pd.DataFrame(rows)
    best = grid.loc[grid["mae"].idxmin()]
    base = grid[grid["w"] == 0.0].iloc[0]
    return {"grid": grid, "best_w": float(best["w"]), "best_k": float(best["k"]),
            "best_mae": float(best["mae"]), "flat_mae": float(base["mae"]),
            "n": len(p)}


def fit() -> dict:
    tables = {s: season_table(s) for s in SEASONS}
    pri = positional_priors(tables)
    shrunk = {k: v["shrunk"] for k, v in pri["by_position"].items()}
    sel = select_weight(tables, shrunk)
    return {"tables": tables, "priors": pri, "persistence": persistence(tables),
            "selection": sel, "shrunk_priors": shrunk}


def main() -> None:
    r = fit()
    print("league assists per 1.0 xA, by season "
          "(2022-23 restricted to GW16+, where xG/xA begins):")
    for s, t in r["tables"].items():
        print(f"  {s}   A/xA {t['assists'].sum() / t['xa'].sum():.3f}"
              f"   G/xG {t['goals'].sum() / t['xg'].sum():.3f}")

    print(f"\npositional priors (league {r['priors']['league']}, shrink K={POS_PRIOR_K} xA):")
    for pos in ("GK", "DEF", "MID", "FWD"):
        v = r["priors"]["by_position"].get(pos)
        if v:
            print(f"  {pos}  raw {v['raw']:5.3f} on {v['xa']:7.1f} xA "
                  f"-> shrunk {v['shrunk']:5.3f}   (shipped {FPL_ASSIST_INFLATION.get(pos)})")

    print("\nyear-over-year persistence:")
    print(r["persistence"].to_string())

    s = r["selection"]
    print(f"\nout-of-sample weight selection on {s['n']} player-season pairs")
    print(f"  flat positional constant   MAE {s['flat_mae']:.4f} assists")
    print(f"  best w={s['best_w']:.2f} k={s['best_k']:.1f}   MAE {s['best_mae']:.4f}"
          f"   ({(s['flat_mae'] - s['best_mae']) / s['flat_mae'] * 100:+.2f}%)")
    g = s["grid"]
    print("\n  MAE by credibility weight (at best k):")
    for _, row in g[g["k"] == s["best_k"]].iterrows():
        mark = "  <-" if row["w"] == s["best_w"] else ""
        print(f"    w={row['w']:.2f}  MAE {row['mae']:.4f}  bias {row['bias']:+.3f}{mark}")

    DATA.mkdir(exist_ok=True)
    (DATA / "assist_inflation.json").write_text(json.dumps({
        "positional_priors": r["shrunk_priors"],
        "league_ratio": r["priors"]["league"],
        "credibility": s["best_w"], "k": s["best_k"],
        "oos_mae_flat": round(s["flat_mae"], 4),
        "oos_mae_fitted": round(s["best_mae"], 4),
        "n_pairs": s["n"],
    }, indent=2))
    print("\n✓ wrote data/assist_inflation.json")


if __name__ == "__main__":
    main()
