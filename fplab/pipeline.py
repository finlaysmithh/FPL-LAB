"""Orchestration: real parquet data -> ratings -> projections -> optimal squad."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import availability, optimize, promoted, ratings, roles, xpts, sources
from .blend import build_player_rates
from .config import (
    LEAGUE_AVG_GOALS_PER_TEAM,
    RETURN_RAMP,
    RETURN_RAMP_MATCHES,
    SIGNING_BED_IN_GWS,
    SIGNING_BED_IN_START,
    XI_FLOOR_HALFLIFE,
)
from .sources import DATA


def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Load the real dataset built by `python -m fplab.build`."""
    need = ["players.parquet", "matchlog.parquet", "fixtures.parquet"]
    missing = [n for n in need if not (DATA / n).exists()]
    if missing:
        raise FileNotFoundError(
            f"Missing {missing}. Run:  python -m fplab.build --season 2026 --prior-season 2025"
        )
    return (pd.read_parquet(DATA / "players.parquet"),
            pd.read_parquet(DATA / "matchlog.parquet"),
            pd.read_parquet(DATA / "fixtures.parquet"))


def import_squad(entry_id: int, gw: int | None = None) -> tuple[list[int], float, int]:
    """Pull your actual FPL squad. Returns (player_ids, bank, free_transfers)."""
    bs = sources.bootstrap()
    gw = gw or max(1, sources.current_gw(bs) - 1)
    picks = sources.entry_picks(entry_id, gw)
    ids = [p["element"] for p in picks["picks"]]
    bank = picks.get("entry_history", {}).get("bank", 0) / 10.0
    return ids, bank, 1


def load_component_weights() -> dict | None:
    """Fitted component weights, if `python -m fplab.fit_components` has run.

    The hand-set DEFAULT_COMPONENT_WEIGHTS were never replaced by anything —
    the fitting step existed but was never called. This makes the fitted file
    the default when it exists, and falls back cleanly when it does not, so a
    fresh clone still works before the fit is run.
    """
    import json
    p = DATA / "component_weights.json"
    if not p.exists():
        return None
    try:
        w = json.loads(p.read_text())
        return {k: float(v) for k, v in w.items()} if isinstance(w, dict) else None
    except Exception:
        return None


def minutes_by_gameweek(players, fixtures, gws, season_start_year=2026):
    """
    Per-gameweek expected minutes, after squad conservation and injuries.

    This is where two things the model used to get wrong are fixed together.

    A club fields eleven players. Every player was previously estimated on his
    own and nothing checked that a club's estimates summed to a football team,
    so Hull fielded seven and a half men and Chelsea sixteen. `roles.allocate`
    imposes the measured budget — 921.8 outfield minutes and 92.7 goalkeeping
    minutes per match — by scaling each club's role scores until they balance.

    And because the scaling runs *per gameweek against that week's
    availability*, minutes freed by an injury flow to the players behind. When
    Saliba and Timber are out, Arsenal's budget has to be met by whoever is
    left, so Mosquera and Calafiori rise — automatically, for all twenty clubs,
    from flags the model already holds. That replaces the depth chart nobody
    was ever going to maintain by hand.

    Returns {gw: frame indexed like `players` with p_play, p_60, p_start,
    mins_share_blend, exp_mins, role_lambda}.
    """
    av = availability.attach_availability(players, fixtures, gws,
                                         season_start_year=season_start_year)
    avail_lists = av["avail_by_gw"].tolist()

    # The role score is the unconstrained estimate of what a player commands
    # when fit — the guarded prior share. Conservation rescales it; it never
    # reorders it.
    role_score = pd.to_numeric(players["mins_share_prior"],
                               errors="coerce").fillna(0.0) * 90.0
    mps = pd.to_numeric(players.get("mins_per_start_prior"), errors="coerce")

    # Availability as a matrix, so a player's PAST weeks are visible when his
    # current one is being built. The return ramp needs to know how long he was
    # out, which a per-gameweek view cannot see.
    A = np.array([[row[j] if j < len(row) else 1.0 for j in range(len(gws))]
                  for row in avail_lists], dtype=float)

    # A price-proxy signing's role score is the market's estimate of where he
    # ENDS UP, not where he starts. See config.SIGNING_BED_IN_*.
    is_signing = (players.get("price_implied_prior",
                              pd.Series(False, index=players.index))
                  .fillna(False).astype(bool).to_numpy())

    out = {}
    for j, gw in enumerate(gws):
        a = pd.Series(A[:, j], index=players.index)

        # ---- return ramp --------------------------------------------------
        # A player coming back from an absence does not resume his old role.
        # `ramp` is 1.0 for anyone who has been available throughout and the
        # measured fraction for the first few matches back, scaled by how long
        # he was out. Applied to the ROLE SCORE, before conservation, so the
        # minutes he does not take are redistributed to his team-mates rather
        # than vanishing from the club's budget.
        ramp = np.ones(len(players))
        if j > 0:
            avail_now = A[:, j] > 0.5
            for i in np.nonzero(avail_now)[0]:
                back = 0          # matches already played since returning
                out_len = 0       # length of the absence he is returning from
                k = j - 1
                while k >= 0 and A[i, k] > 0.5 and back < RETURN_RAMP_MATCHES:
                    back += 1
                    k -= 1
                if k < 0 or A[i, k] > 0.5:
                    continue      # no absence in the window: full role
                while k >= 0 and A[i, k] <= 0.5:
                    out_len += 1
                    k -= 1
                if out_len < 2 or back >= RETURN_RAMP_MATCHES:
                    continue      # a single missed week is not an absence
                key = next(t for t in sorted(RETURN_RAMP) if out_len <= t)
                ramp[i] = RETURN_RAMP[key][back]

        # ---- new-signing bed-in -------------------------------------------
        bed = np.ones(len(players))
        if SIGNING_BED_IN_GWS > 0:
            frac = min(1.0, j / SIGNING_BED_IN_GWS)
            bed[is_signing] = (SIGNING_BED_IN_START
                               + (1.0 - SIGNING_BED_IN_START) * frac)

        rs = role_score * pd.Series(ramp * bed, index=players.index)

        # ---- predicted-XI floor decay --------------------------------------
        # Full weight in GW1, fading by half-life, because by GW6 the model has
        # watched five team sheets and no longer needs a pre-season guess.
        xi_w = 0.5 ** (j / XI_FLOOR_HALFLIFE) if XI_FLOOR_HALFLIFE > 0 else 0.0

        alloc = roles.allocate(rs, players["team"], players["position"],
                               a, mins_per_start=mps,
                               predicted_xi=players.get("predicted_xi"),
                               xi_floor_weight=xi_w,
                               evidence_minutes=players.get("prior_minutes"))
        probs = roles.probabilities(alloc["mins_share"], nailed=alloc["nailed"] * a)
        probs.index = players.index
        frame = pd.concat([alloc, probs], axis=1)
        frame["mins_share_blend"] = alloc["mins_share"]
        out[gw] = frame
    return out


def build_projections(players, matchlog, fixtures, gws, weights=None):
    rt = ratings.team_ratings(matchlog)
    league_mu = float(matchlog["xg_for"].mean() or LEAGUE_AVG_GOALS_PER_TEAM)

    # Align last season's ratings with THIS season's 20 clubs: drop relegated
    # sides, give promoted sides a promoted-team prior. Without this, every
    # fixture involving a promoted club is silently dropped — which also
    # deletes the easiest fixtures for the 17 established clubs.
    current_teams = sorted(set(fixtures["home"]) | set(fixtures["away"]))
    rt = promoted.reconcile(rt, current_teams)

    upcoming = fixtures[~fixtures["finished"]] if "finished" in fixtures else fixtures
    ftab = ratings.fixture_lambdas(upcoming, rt, league_mu)

    missing = set(upcoming[upcoming.gw.isin(gws)]["home"]) - set(ftab["team"])
    if missing:
        raise RuntimeError(f"Fixtures dropped for teams with no rating: {missing}")

    team_xg90 = {t: float(league_mu * rt.at[t, "att"]) for t in rt.index}
    blended = build_player_rates(players, team_xg90)
    for c in ("p_play", "p_60", "mins_frac"):
        if c in players.columns:
            blended[c] = players[c].values
    blended["mins_share_blend"] = blended.get("mins_frac", blended["mins_share_blend"])
    # Expected minutes per game, derived from the SAME share that drives xP —
    # so the optimiser's eligibility gate and the points model never disagree.
    blended["exp_mins"] = blended["mins_share_blend"].astype(float) * 90.0
    for c in ("minutes_flag", "minutes_ceiling", "mins_share_raw"):
        if c in players.columns:
            blended[c] = players[c].values

    if weights is None:
        weights = load_component_weights()

    # Minutes are resolved per gameweek, before projection, so the solver, the
    # charts and the squad page all read one set of numbers. Availability used
    # to be applied *after* projection by multiplying the finished xP, which
    # zeroed an injured player correctly but never gave his minutes to anyone.
    mbg = minutes_by_gameweek(players, fixtures, gws)
    for f in mbg.values():
        f.index = blended.index
    proj = xpts.project(blended, ftab, team_xg90, gws, weights, minutes_by_gw=mbg)
    proj.attrs["minutes_by_gw"] = mbg
    return proj, rt, ftab


# Whether the simulated bonus REPLACES the analytic curve inside xp.
#
# Off, and this is the evidence, including a correction to an earlier claim of
# my own. The zero-sum argument for replacing it was that the curve awards 8.56
# bonus points per match against FPL's 6.00 — but that figure was measured over
# the whole 580-player pre-season registry, most of whom do not play. Measured
# over the players who actually featured, which is the population that matters,
# the curve awards 6.19 per match. It is very nearly right, and the headline
# reason for replacing it was an artefact of the population I measured on.
#
# On the bonus component alone the simulation is genuinely better:
#
#                    mean pred   real    MAE      rank corr
#     curve            0.2075   0.2138  0.3565     0.1469
#     simulated        0.1642   0.2138  0.3176     0.1580
#
# Better MAE (-11%) and better rank correlation (+7%). And yet, run through the
# full engine, it makes FPL DECISIONS worse — most visibly the one that costs
# the most:
#
#     captain points   2024-25   8.89 -> 8.51
#                      2025-26   7.46 -> 6.74
#     calibration      0.769 -> 0.752 and 0.710 -> 0.695
#
# The mechanism is the zero-sum property itself. Capping a match at six bonus
# points spreads expected bonus across everyone who MIGHT play, so a nailed
# premium loses bonus to squad players who then do not feature. That is correct
# ex ante and wrong for ranking, because the manager already knows who starts.
#
# So the simulation stays — its DISTRIBUTIONS are the reason it exists, and
# they cost nothing because they do not feed xp — but the validated curve keeps
# the points.
SIM_BONUS_REPLACES_CURVE = False


def with_simulation(proj, players, fixtures, ftab, gws, n_sims=None,
                    replace_bonus=SIM_BONUS_REPLACES_CURVE):
    """
    Attach the simulated points distribution, and optionally the bonus.

    The distribution fields are the point of this: ceiling, floor and haul
    probability are things the analytic engine cannot express at all, and
    captaincy is a bet on a ceiling rather than on a mean. Bonus replacement is
    off by default — see SIM_BONUS_REPLACES_CURVE.
    """
    mbg = proj.attrs.get("minutes_by_gw", {})
    sim = simulate_projections(proj, players, fixtures, ftab, mbg, gws, n_sims)
    if sim.empty:
        return proj

    out = proj.merge(sim, on=["fpl_id", "gw"], how="left", suffixes=("", "_sim"))
    if replace_bonus:
        have = out["e_bonus"].notna()
        out.loc[have, "xp"] = (out.loc[have, "xp"]
                               - out.loc[have, "xp_bonus"].fillna(0.0)
                               + out.loc[have, "e_bonus"])
        out.loc[have, "xp_bonus"] = out.loc[have, "e_bonus"]
    return out


def simulate_projections(proj, players, fixtures, ftab, minutes_by_gw, gws,
                         n_sims=None):
    """
    Monte-Carlo every fixture, for zero-sum bonus and the shape of a projection.

    Two things the analytic engine cannot do. Bonus is a CONTEST — exactly
    three points per match, six counting 3+2+1 — and a per-player rate model
    cannot respect that: the shipped curve awards 8.56 bonus points per match
    against a real 6.00, because every player is scored against a league-wide
    curve instead of against the eleven opponents he is actually playing.

    And an expected value has no shape. Captaincy is a bet on a ceiling, so
    "6.5 expected points" from a forward and from a defender are different
    decisions; only a distribution can say how.

    See fplab.simulate for the model itself.
    """
    from . import simulate as sim_mod
    n_sims = n_sims or sim_mod.N_SIMS

    base = players.set_index("fpl_id")
    s = proj.copy()
    s["defcon90"] = s["fpl_id"].map(base.get("defcon90_prior", pd.Series(dtype=float))).fillna(0.0)
    # BPS earned from everything the simulator does NOT re-derive (passes,
    # tackles, recoveries, saves). Goals, assists, clean sheets and appearance
    # are simulated explicitly and must not be double-counted, so the baseline
    # is the residual share of a player's BPS rate.
    s["bps_base"] = s["fpl_id"].map(
        base.get("bps90_prior", pd.Series(dtype=float))).fillna(0.0) * BPS_RESIDUAL

    ft = ftab.set_index(["team", "gw"])
    s["cs_prob"] = [float(ft.at[(t, g), "cs_prob"]) if (t, g) in ft.index else 0.25
                    for t, g in zip(s["team"], s["gw"])]

    key = {}
    up = fixtures[fixtures["gw"].isin(gws)]
    for _, f in up.iterrows():
        tag = f"{f['gw']}:{f['home']}-{f['away']}"
        key[(f["home"], f["gw"])] = tag
        key[(f["away"], f["gw"])] = tag
    s["match_key"] = [key.get((t, g)) for t, g in zip(s["team"], s["gw"])]

    mp = {}
    for g in gws:
        fr = minutes_by_gw.get(g)
        if fr is None:
            continue
        ids = players["fpl_id"].to_numpy()
        for c in ("p_play", "p_60", "mins_share"):
            mp[(g, c)] = dict(zip(ids, fr[c].to_numpy()))
    for c in ("p_play", "p_60", "mins_share"):
        s[c] = [mp.get((g, c), {}).get(i, 0.0) for g, i in zip(s["gw"], s["fpl_id"])]

    s = s[s["match_key"].notna()]
    out = [sim_mod.simulate_gameweek(s, g, n_sims=n_sims) for g in gws]
    out = [o for o in out if len(o)]
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


# Share of a player's BPS rate that comes from events the simulator does not
# model explicitly. FPL's BPS table pays for passes completed, tackles,
# recoveries, saves and clearances as well as for goals and clean sheets;
# rebuilding all of those would add a lot of machinery for events that are
# close to constant per appearance. Goals, assists, clean sheets and appearance
# points are simulated and added on top, so this is the residual — set so the
# simulated total BPS per match matches the real distribution.
BPS_RESIDUAL = 0.55


def plan(proj, gws, *, n_alternatives=3, **kw):
    best = optimize.solve(proj, gws, **kw)
    alts = optimize.alternatives(proj, gws, n=n_alternatives, **kw)[1:] if n_alternatives else []
    return {"best": best, "alternatives": alts}


def squad_table(result, gws):
    meta, xp = result["meta"], result["xp_table"]
    w0 = result["weeks"][0]
    xi, cap = set(w0["xi"]), w0["captain"]
    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    rows = []
    for i in w0["squad"]:
        rows.append({
            "player": meta.at[i, "display_name"],
            "pos": meta.at[i, "position"],
            "team": meta.at[i, "team"],
            "£m": meta.at[i, "price"],
            "own%": meta.at[i, "ownership"],
            "role": "(C)" if i == cap else ("XI" if i in xi else "Bench"),
            **{f"GW{g}": round(float(xp.at[i, g]), 2) for g in gws},
            "total": round(float(sum(xp.at[i, g] for g in gws)), 2),
        })
    df = pd.DataFrame(rows)
    df["_o"] = df["pos"].map(order)
    return df.sort_values(["_o", "total"], ascending=[True, False]).drop(columns="_o")


def transfer_plan(result, meta=None):
    """Week-by-week transfer schedule — the thing v1 could not produce."""
    meta = meta if meta is not None else result["meta"]
    nm = lambda i: meta.at[i, "display_name"] if i in meta.index else str(i)
    rows = []
    for w in result["weeks"]:
        rows.append({
            "GW": w["gw"],
            "out": ", ".join(nm(i) for i in w["transfers_out"]) or "—",
            "in": ", ".join(nm(i) for i in w["transfers_in"]) or "—",
            "hits": -4 * w["hits"] if w["hits"] else 0,
            "captain": nm(w["captain"]) if w["captain"] else "—",
            "xP": w["xp"],
            "cost": w["cost"],
        })
    return pd.DataFrame(rows)
