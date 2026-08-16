"""
Dixon-Coles low-score correction, and the test of whether it earns its place.

The independent-Poisson model that `ratings.fixture_lambdas` produces treats
the two teams' goal counts as independent. They are not: real football produces
more 0-0 and 1-1 draws than independence predicts, and fewer 1-0 and 0-1. Dixon
& Coles (1997) handle this with a single dependency parameter applied to the
four low scorelines:

    tau(0,0) = 1 - lam*mu*rho
    tau(0,1) = 1 + lam*rho
    tau(1,0) = 1 + mu*rho
    tau(1,1) = 1 - rho
    tau(x,y) = 1                      everywhere else

For FPL only one consequence really matters, and it is a big one: **clean
sheet probability**. Under independence P(opponent scores 0) is exp(-mu). Under
Dixon-Coles it is not, and clean sheets are worth 4 points to a defender or
goalkeeper plus the goals-conceded penalty they avoid — so a systematic error
here is a systematic error on every defender in the game.

WHY THIS MODULE ALSO CONTAINS THE TEST
--------------------------------------
Dixon-Coles is famous, which is a bad reason to ship it. The question is not
whether football has low-score dependency — it does — but whether correcting
for it improves FPL clean-sheet forecasts out of sample. `evaluate()` answers
that directly, scoring the corrected and uncorrected clean-sheet probabilities
against real results with Brier score and calibration, and `main()` prints
both. If the correction does not win, it does not ship.
"""
from __future__ import annotations

from math import exp, factorial

import numpy as np
import pandas as pd

from . import ratings, team_history
from .sources import DATA

# Dixon & Coles report rho near -0.13 for English league football. It is fitted
# here rather than assumed — see `fit_rho`.
DEFAULT_RHO = -0.13

# Above this many goals the Poisson tail contributes nothing worth carrying.
MAX_GOALS = 10


def tau(x, y, lam, mu, rho):
    """The Dixon-Coles low-score adjustment. Vectorised over x and y."""
    x = np.asarray(x); y = np.asarray(y)
    lam = np.asarray(lam, dtype=float); mu = np.asarray(mu, dtype=float)
    out = np.ones(np.broadcast(x, y, lam, mu).shape, dtype=float)
    out = np.where((x == 0) & (y == 0), 1.0 - lam * mu * rho, out)
    out = np.where((x == 0) & (y == 1), 1.0 + lam * rho, out)
    out = np.where((x == 1) & (y == 0), 1.0 + mu * rho, out)
    out = np.where((x == 1) & (y == 1), 1.0 - rho, out)
    # A large rho with large lambdas can drive tau negative, which is not a
    # probability. Clip rather than let a scoreline carry negative mass.
    return np.clip(out, 1e-9, None)


def _pois(k, lam):
    return np.exp(-lam) * lam ** k / factorial(k)


def score_matrix(lam: float, mu: float, rho: float = DEFAULT_RHO,
                 max_goals: int = MAX_GOALS) -> np.ndarray:
    """Joint PMF over scorelines, Dixon-Coles corrected and renormalised."""
    ks = np.arange(max_goals + 1)
    ph = np.array([_pois(k, lam) for k in ks])
    pa = np.array([_pois(k, mu) for k in ks])
    m = np.outer(ph, pa)
    xs, ys = np.meshgrid(ks, ks, indexing="ij")
    m = m * tau(xs, ys, lam, mu, rho)
    return m / m.sum()


def clean_sheet_prob(lam_against: float, lam_for: float,
                     rho: float = DEFAULT_RHO) -> float:
    """
    P(the opponent fails to score), Dixon-Coles corrected.

    Note it depends on BOTH lambdas — that is the whole point of the
    correction. Under independence a team's clean-sheet chance is a fact about
    its own defence alone; under Dixon-Coles a tight game at both ends is more
    likely to finish goalless than independence allows.
    """
    m = score_matrix(lam_for, lam_against, rho)
    return float(m[:, 0].sum())


def fit_rho(log: pd.DataFrame, lam_col="lam_for", mu_col="lam_against",
            gf="goals_for", ga="goals_against") -> float:
    """Maximum-likelihood rho on real scorelines, by grid then golden search."""
    lam = log[lam_col].to_numpy(float)
    mu = log[mu_col].to_numpy(float)
    x = log[gf].to_numpy(int)
    y = log[ga].to_numpy(int)

    def nll(r):
        t = tau(np.minimum(x, 2), np.minimum(y, 2), lam, mu, r)
        return -np.log(np.clip(t, 1e-12, None)).sum()

    grid = np.linspace(-0.35, 0.15, 101)
    best = min(grid, key=nll)
    lo, hi = best - 0.01, best + 0.01
    for _ in range(60):
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        if nll(m1) < nll(m2):
            hi = m2
        else:
            lo = m1
    return float((lo + hi) / 2)


def _real_log() -> pd.DataFrame:
    """Team-match log with model lambdas AND real goals, walk-forward by season."""
    rows = []
    for season in team_history.SEASONS:
        base = DATA / f"vaastav_{season}"
        gws = pd.read_csv(base / "gws" / "merged_gw.csv")
        teams = pd.read_csv(base / "teams.csv")
        short = dict(zip(teams["id"], teams["short_name"]))
        name2short = dict(zip(teams["name"], teams["short_name"]))

        goals = {}
        for _, r in gws.drop_duplicates(subset=["fixture", "team"]).iterrows():
            t = name2short.get(r["team"], short.get(r["team"]))
            if t is None:
                continue
            h, a = r.get("team_h_score"), r.get("team_a_score")
            if pd.isna(h) or pd.isna(a):
                continue
            gf, ga = (int(h), int(a)) if r["was_home"] else (int(a), int(h))
            goals[(r["fixture"], t)] = (gf, ga)

        log = team_history._season_log(season)
        rt = ratings.team_ratings(log)
        mu = float(log["xg_for"].mean())
        fx = log[["team", "opponent", "was_home"]].copy()
        fx["home"] = np.where(fx["was_home"], fx["team"], fx["opponent"])
        fx["away"] = np.where(fx["was_home"], fx["opponent"], fx["team"])
        fx["gw"] = 1
        lam = ratings.fixture_lambdas(fx.drop_duplicates(["home", "away"]), rt, mu)

        key = {(r.team, r.opponent, r.was_home): (r.lam_for, r.lam_against)
               for r in lam.itertuples()}
        for (fixture, t), (gf, ga) in goals.items():
            sub = log[(log["team"] == t)]
            if sub.empty:
                continue
            for r in sub.itertuples():
                k = (r.team, r.opponent, r.was_home)
                if k in key:
                    lf, la = key[k]
                    rows.append({"season": season, "team": t, "lam_for": lf,
                                 "lam_against": la, "goals_for": gf,
                                 "goals_against": ga, "cs": int(ga == 0)})
                    break
    return pd.DataFrame(rows)


def evaluate(log: pd.DataFrame, rho: float) -> dict:
    """Brier score and calibration for clean sheets, corrected vs independent."""
    lam_f = log["lam_for"].to_numpy(float)
    lam_a = log["lam_against"].to_numpy(float)
    cs = log["cs"].to_numpy(float)

    p_indep = np.exp(-lam_a)
    p_dc = np.array([clean_sheet_prob(a, f, rho) for a, f in zip(lam_a, lam_f)])

    def brier(p):
        return float(np.mean((p - cs) ** 2))

    return {
        "n": len(log), "rho": rho, "real_cs_rate": float(cs.mean()),
        "indep_mean_p": float(p_indep.mean()), "indep_brier": brier(p_indep),
        "dc_mean_p": float(p_dc.mean()), "dc_brier": brier(p_dc),
    }


def main() -> None:
    log = _real_log()
    if log.empty:
        print("no scoreline data resolved")
        return
    print(f"{len(log)} team-matches with real scorelines across "
          f"{log['season'].nunique()} seasons")

    print("\nHOLD-OUT: fit rho on the other seasons, test on this one")
    hdr = f"{'test':10s} {'rho_fit':>8s} {'realCS':>7s} {'indepP':>7s} {'dcP':>7s} " \
          f"{'indepBrier':>11s} {'dcBrier':>9s} {'verdict':>9s}"
    print(hdr)
    for s in sorted(log["season"].unique()):
        tr, te = log[log["season"] != s], log[log["season"] == s]
        r = fit_rho(tr)
        e = evaluate(te, r)
        better = e["dc_brier"] < e["indep_brier"]
        print(f"{s:10s} {r:8.4f} {e['real_cs_rate']:7.3f} {e['indep_mean_p']:7.3f} "
              f"{e['dc_mean_p']:7.3f} {e['indep_brier']:11.5f} {e['dc_brier']:9.5f} "
              f"{'DC' if better else 'indep':>9s}")

    full = fit_rho(log)
    e = evaluate(log, full)
    print(f"\nrho fitted on all seasons: {full:.4f}  "
          f"(Dixon & Coles report about {DEFAULT_RHO} for English football)")
    print(f"  real clean-sheet rate {e['real_cs_rate']:.4f}")
    print(f"  independent Poisson   {e['indep_mean_p']:.4f}  Brier {e['indep_brier']:.5f}")
    print(f"  Dixon-Coles           {e['dc_mean_p']:.4f}  Brier {e['dc_brier']:.5f}")


if __name__ == "__main__":
    main()
