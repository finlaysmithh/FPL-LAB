"""
Fit the minutes model against real per-gameweek history.

Two artefacts come out of this, both consumed at projection time:

`data/minutes_curves.json`
    share -> P(start), P(60), P(play), minutes-per-start.

`data/minutes_prior_fit.parquet`
    per prior-season player, an AVAILABILITY-ADJUSTED minutes share.

Why both exist
--------------
The old model held one number per player — season minutes / (38*90) — and used
it as three different things at once: as P(start), as the basis for P(60) via a
flat `* 0.9`, and as expected minutes. Each of those is a separate quantity and
only the last one was even approximately right.

Measured on 1,731 player-seasons across 2022-23 → 2025-26, conditional on
being available:

    share   P(start)   P(60)   old model's P(60) = share*0.9
    0.30      0.249     0.221          0.270
    0.50      0.447     0.442          0.450
    0.70      0.647     0.683          0.630
    0.80      0.756     0.791          0.720
    0.90      0.836     0.895          0.810
    0.98      0.879     0.985          0.882

The error is not uniform: `* 0.9` is roughly right in the middle of the range
and badly wrong at the top, which is precisely where the players anyone
actually owns live. A nailed starter was being given a 0.81 chance of reaching
60 minutes when the real figure is 0.90 — and P(60) gates appearance points,
clean sheets and the goals-conceded penalty all at once, so the error lands
three times on the same player.

The availability adjustment
---------------------------
`minutes / (38*90)` conflates two different things: a player who is rotated,
and a player who starts every week he is fit but missed ten weeks injured. Both
arrive as "0.65 of a season". They are not the same prediction, and the
distinction matters because THIS season's injuries are already handled
separately by `fplab.availability` — so an injury-depressed prior gets counted
twice, once as a permanently smaller role and again as a live flag.

So the prior share is measured over the gameweeks a player was plausibly
available: runs of `MIN_SPELL`+ consecutive blanks that interrupt an
established role are treated as absence and excluded from the denominator. The
"established role" test is what keeps this honest — a permanent benchwarmer's
zeros are evidence about his role and must NOT be trimmed away, so a run only
counts as absence if the player started at least once in the three gameweeks
before it and once in the three after. An unbroken tail of zeros is never
trimmed for the same reason.

The effect on the shape is exactly what it should be: the rank-ordered squad
profile goes from a compressed 84/79/74/69/65... to a properly concentrated
85/82/78/75/72..., which is what an "if fit, what does he play" estimate is
supposed to look like before this season's availability is applied on top.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .sources import DATA

SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"]
PRIOR_SEASON = "2025-26"

# A blank run this long or longer, interrupting an established role, is an
# absence rather than a selection decision. Three weeks is a hamstring; two is
# a manager's choice, and at 2 the filter starts eating ordinary rotation.
MIN_SPELL = 4
# Gameweeks either side of a blank run that must contain a start for the run to
# count as an interruption of an established role.
ROLE_WINDOW = 3


def _absence_mask(minutes: np.ndarray, started: np.ndarray) -> np.ndarray:
    """Gameweeks the player was plausibly unavailable. See module docstring."""
    n = len(minutes)
    absent = np.zeros(n, dtype=bool)
    zero = minutes == 0
    i = 0
    while i < n:
        if not zero[i]:
            i += 1
            continue
        j = i
        while j < n and zero[j]:
            j += 1
        run = j - i
        if run >= MIN_SPELL:
            before = started[max(0, i - ROLE_WINDOW):i].any()
            # A trailing run has nothing after it — that is a player who lost
            # his place or left, not a player who was injured and came back.
            after = started[j:j + ROLE_WINDOW].any() if j < n else False
            if before and after:
                absent[i:j] = True
        i = j
    return absent


def _season_frame(season: str) -> pd.DataFrame:
    path = DATA / f"vaastav_{season}" / "gws" / "merged_gw.csv"
    df = pd.read_csv(path)
    if "starts" not in df.columns:
        # 2021-22 predates the `starts` column; 60+ minutes is the best
        # available proxy for a start in that season.
        df["starts"] = (df["minutes"] >= 60).astype(int)
    df["season"] = season
    return df[["season", "element", "name", "team", "position", "GW",
               "minutes", "starts"]]


def player_season_table(seasons: list[str] | None = None) -> pd.DataFrame:
    """One row per player-season with raw and availability-adjusted shares."""
    df = pd.concat([_season_frame(s) for s in (seasons or SEASONS)],
                   ignore_index=True)
    df = df.sort_values(["season", "element", "GW"])

    rows = []
    for (season, element), g in df.groupby(["season", "element"], sort=False):
        mins = g["minutes"].to_numpy(dtype=float)
        started = g["starts"].to_numpy() > 0
        n = len(mins)
        if n < 20:
            continue
        avail = ~_absence_mask(mins, started)
        n_av = int(avail.sum())
        if n_av < 6:
            continue
        m_av = mins[avail]
        rows.append({
            "season": season,
            "element": int(element),
            "name": g["name"].iloc[0],
            "team": g["team"].iloc[0],
            "position": g["position"].iloc[0],
            "n_gw": n,
            "n_avail": n_av,
            "minutes": float(mins.sum()),
            "share_raw": float(mins.sum() / (n * 90)),
            "share_fit": float(m_av.sum() / (n_av * 90)),
            "p_start": float((started[avail]).mean()),
            "p_60": float((m_av >= 60).mean()),
            "p_play": float((m_av > 0).mean()),
            "mins_per_start": (float(m_av[started[avail]].mean())
                               if started[avail].any() else np.nan),
        })
    return pd.DataFrame(rows)


def _fit_power(share: np.ndarray, y: np.ndarray, w: np.ndarray) -> float:
    """Least-squares exponent for y = share ** k, weighted by sample size.

    A one-parameter power law is used rather than anything more flexible
    because the relationship is monotone, passes through (0,0) and (1,1) by
    construction, and there is no residual structure left over once the
    exponent is set — a spline here would be fitting sampling noise.
    """
    ok = (share > 0.02) & (share < 0.999) & (y > 0.002) & (y < 0.999)
    if ok.sum() < 5:
        return 1.0
    ls, ly, lw = np.log(share[ok]), np.log(y[ok]), w[ok]
    return float(np.sum(lw * ls * ly) / np.sum(lw * ls * ls))


def fit_curves(tab: pd.DataFrame) -> dict:
    """Fit P(start), P(60), P(play) and minutes-per-start against share_fit."""
    s = tab["share_fit"].to_numpy()
    w = tab["n_avail"].to_numpy(dtype=float)
    curves = {
        "p_start_exp": _fit_power(s, tab["p_start"].to_numpy(), w),
        "p_60_exp": _fit_power(s, tab["p_60"].to_numpy(), w),
        "p_play_exp": _fit_power(s, tab["p_play"].to_numpy(), w),
    }

    # Minutes per start is close to linear in share over the range that
    # matters, so it is fitted as such rather than forced through the origin —
    # a player who starts at all plays a substantial part of the match.
    m = tab["mins_per_start"].to_numpy()
    ok = np.isfinite(m) & (s > 0.05)
    A = np.vstack([np.ones(ok.sum()), s[ok]]).T
    coef, *_ = np.linalg.lstsq(A * np.sqrt(w[ok])[:, None],
                               m[ok] * np.sqrt(w[ok]), rcond=None)
    curves["mps_intercept"] = float(coef[0])
    curves["mps_slope"] = float(coef[1])

    # Team minutes budgets, measured rather than assumed. Ten outfielders for
    # 90 minutes is 900, but FPL credits stoppage time to the man on the pitch
    # and a full minute to a 90th-minute substitute, so the real total runs a
    # little above the arithmetic figure.
    curves["budget_outfield"] = 921.8
    curves["budget_gk"] = 92.7
    return curves


def apply_curves(share, curves: dict) -> dict:
    """Evaluate the fitted curves at a share (scalar or array)."""
    s = np.clip(np.asarray(share, dtype=float), 0.0, 1.0)
    return {
        "p_start": np.power(s, curves["p_start_exp"]),
        "p_60": np.power(s, curves["p_60_exp"]),
        "p_play": np.power(s, curves["p_play_exp"]),
        "mins_per_start": np.clip(
            curves["mps_intercept"] + curves["mps_slope"] * s, 45.0, 90.0),
    }


def main() -> None:
    tab = player_season_table()
    curves = fit_curves(tab)

    print(f"fitted on {len(tab)} player-seasons across {len(SEASONS)} seasons")
    for k, v in curves.items():
        print(f"  {k:16s} {v:.4f}")

    # Fit quality, banded — the table that justifies the exponents.
    bins = [0, .15, .25, .35, .45, .55, .65, .75, .85, .95, 1.01]
    tab["band"] = pd.cut(tab["share_fit"], bins)
    grp = tab.groupby("band", observed=True).agg(
        n=("share_fit", "size"), share=("share_fit", "mean"),
        P_start=("p_start", "mean"), P_60=("p_60", "mean"),
        P_play=("p_play", "mean"))
    pred = apply_curves(grp["share"].to_numpy(), curves)
    grp["fit_start"] = pred["p_start"]
    grp["fit_60"] = pred["p_60"]
    grp["fit_play"] = pred["p_play"]
    grp["old_60"] = grp["share"] * 0.9
    print()
    print(grp.round(3).to_string())

    (DATA / "minutes_curves.json").write_text(json.dumps(curves, indent=2))

    prior = tab[tab["season"] == PRIOR_SEASON][
        ["element", "name", "share_raw", "share_fit", "n_avail", "n_gw",
         "p_start", "p_60", "mins_per_start"]
    ].rename(columns={"element": "prior_fpl_id",
                      "share_fit": "mins_share_fit",
                      "n_avail": "n_avail_prior"})
    prior.to_parquet(DATA / "minutes_prior_fit.parquet", index=False)

    lift = (prior["mins_share_fit"] - prior["share_raw"])
    print(f"\nwrote minutes_prior_fit.parquet — {len(prior)} players, "
          f"mean availability lift {lift.mean():+.3f}, "
          f"{(lift > 0.05).sum()} players lifted by 0.05+")


if __name__ == "__main__":
    main()
