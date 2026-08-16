"""Regenerate webapp/data.json and webapp/optimal.json from the real dataset.
Run from the project root after `python -m fplab.build_real`.
"""
import json, sys, warnings
from pathlib import Path
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
from fplab import availability, minutes, pipeline

GWS = list(range(1, 20))   # first half of the season
OUT = Path(__file__).resolve().parent

players, matchlog, fixtures = pipeline.load()
proj, rt, ftab = pipeline.build_projections(players, matchlog, fixtures, GWS)
# Monte-Carlo every fixture: zero-sum bonus, plus the distribution behind each
# projection. See pipeline.with_simulation.
proj = pipeline.with_simulation(proj, players, fixtures, ftab, GWS)

# Availability is now resolved inside `pipeline.build_projections`, per
# gameweek, BEFORE the projection rather than after it. The old code multiplied
# finished expected points by an availability factor here, which zeroed an
# injured player correctly but gave his minutes to nobody — so Arsenal kept
# fielding nine men whenever two defenders were hurt. `pipeline.minutes_by_gw`
# reallocates them instead, which is why this step is gone.
w = proj.pivot_table(index="fpl_id", columns="gw", values="xp", fill_value=0.0)
meta = proj.drop_duplicates("fpl_id").set_index("fpl_id")

# Per-player component totals across the horizon, so the charts can show WHY a
# player scores rather than only how much: goals, creativity, clean sheets,
# defensive contribution and bonus are all separate levers in FPL.
COMPONENTS = {
    "cg": "xp_goals", "ca": "xp_assists", "ccs": "xp_cs",
    "cdc": "xp_defcon", "cbp": "xp_bonus", "csv": "xp_saves",
    "cgc": "xp_conceded", "cap": "xp_appearance",
}
comp_tot = {}
for short, col in COMPONENTS.items():
    if col in proj.columns:
        comp_tot[short] = proj.groupby("fpl_id")[col].sum()
raw_tot = {}
for short, col in (("xg", "xg_fix"), ("xa", "xa_fix")):
    if col in proj.columns:
        raw_tot[short] = proj.groupby("fpl_id")[col].sum()

# Simulation output. An expected value has no shape, and FPL decisions depend
# on shape: captaincy is a bet on a ceiling, a bench slot is a bet on a floor.
# `hi` is the 90th-percentile single-gameweek score — the realistic ceiling —
# and `h10` the chance of a double-figure haul in the best week of the horizon.
sim_tot = {}
if "p90" in proj.columns:
    g = proj.groupby("fpl_id")
    sim_tot = {
        # xP assuming he starts — quality with the minutes risk stripped out.
        "xs": g["xp_start"].mean(),
        "hi": g["p90"].max(),                 # best realistic single-week score
        "sd": g["sd_points"].mean(),          # week-to-week volatility
        "h10": g["p_10plus"].max(),           # best chance of a 10+ haul
        "h6": g["p_6plus"].mean(),            # typical chance of a returning week
        "flr": g["p10"].mean(),               # typical bad week
    }

# Availability + transparency fields straight off the players parquet:
# st  FPL status char (a/d/i/s/u)      ch  chance_of_playing_next_round
# nw  the news string behind a flag    pr  1 = rates are a price-implied proxy
# Start / 60-minute probabilities, taken from the projection itself rather than
# recomputed here. They used to come from a second, independent call to
# `minutes.attach`, which meant the number shown next to a player ("88% to
# start") was not the number that produced his projected points — the display
# path knew nothing about squad conservation or reallocated injury minutes.
# One source of truth now: these are the GW1 values the engine actually used.
_first = proj[proj["gw"] == GWS[0]].drop_duplicates("fpl_id").set_index("fpl_id")
# Minutes per gameweek, so the UI can show a player's role changing when the
# man ahead of him is injured — the whole point of reallocating.
mins_by_gw = proj.pivot_table(index="fpl_id", columns="gw",
                              values="exp_mins_gw", fill_value=0.0)
probs = pd.DataFrame({
    "p_start": _first["p_start_gw"],
    "p_60": _first["p60_gw"],
    "p_play": _first["p_play_gw"],
    # Averaged across the horizon rather than read off GW1. James Garner is
    # the case: injured for the opening week and fit for the eighteen after
    # it, he showed "0 expected minutes" beside 76 projected points, which
    # reads as a bug rather than as a player who misses one game.
    "exp_mins_gw": mins_by_gw.mean(axis=1),
})

flags = players.set_index("fpl_id")[
    ["status", "chance_playing", "news", "price_implied_prior", "no_pl_history",
     "exp_mins", "minutes_flag", "is_new_signing", "prior_club"]
]
preseason = bool((pd.to_numeric(players["n90_now"], errors="coerce")
                  .fillna(0.0) == 0).all())

out = []
for pid in w.index:
    m = meta.loc[pid]
    f = flags.loc[pid] if pid in flags.index else None
    row = {
        "i": int(pid), "n": str(m["display_name"])[:24], "t": m["team"], "p": m["position"],
        "c": round(float(m["price"]), 1), "o": round(float(m.get("ownership", 0)), 1),
        "x": round(float(w.loc[pid].sum()), 2),
        "g": [round(float(w.at[pid, g]), 2) for g in GWS],
        "pk": int(m["pen_order"]) if pd.notna(m.get("pen_order")) else 0,
    }
    for short, series in comp_tot.items():
        if pid in series.index:
            row[short] = round(float(series.at[pid]), 2)
    for short, series in raw_tot.items():
        if pid in series.index:
            row[short] = round(float(series.at[pid]), 2)
    for short, series in sim_tot.items():
        if pid in series.index and pd.notna(series.at[pid]):
            row[short] = round(float(series.at[pid]), 2)
    if f is not None:
        st = str(f["status"]) if pd.notna(f["status"]) else "a"
        if st != "a":
            row["st"] = st
            if pd.notna(f["chance_playing"]):
                row["ch"] = int(f["chance_playing"])
            if pd.notna(f["news"]) and str(f["news"]).strip():
                row["nw"] = str(f["news"]).strip()[:90]
        if bool(f["price_implied_prior"]) or bool(f["no_pl_history"]):
            row["pr"] = 1
        if str(f["minutes_flag"] or ""):
            row["mf"] = str(f["minutes_flag"])
        if bool(f["is_new_signing"]):
            row["ns"] = 1                                   # arrived this summer
            if pd.notna(f["prior_club"]) and str(f["prior_club"]) != m["team"]:
                row["pc"] = str(f["prior_club"])             # came from
    if pid in probs.index:
        pr = probs.loc[pid]
        # ps = P(starts), p60 = P(plays 60+). Rounded to whole percent: the
        # model is nowhere near precise enough to justify a decimal, and
        # showing one would imply a confidence we do not have.
        row["ps"] = int(round(float(pr["p_start"]) * 100))
        row["p60"] = int(round(float(pr["p_60"]) * 100))
        # pp = P(any appearance). The XI selector needs it separately from ps
        # because the autosub only fires on a player who played ZERO minutes —
        # a cameo blocks the substitution while returning almost nothing.
        row["pp"] = int(round(float(pr["p_play"]) * 100))
        row["xm"] = round(float(pr["exp_mins_gw"]), 1)     # expected minutes/game
    if pid in mins_by_gw.index:
        mg = [round(float(mins_by_gw.at[pid, g]), 1) for g in GWS]
        # Only worth shipping when the player's role actually moves across the
        # horizon — otherwise it is 19 copies of `xm` in every player record.
        if max(mg) - min(mg) >= 3.0:
            row["mg"] = mg
    out.append(row)
out.sort(key=lambda r: -r["x"])

fd = {}
for t in sorted(set(ftab.team)):
    s = ftab[(ftab.team == t) & (ftab.gw.isin(GWS))]
    fd[t] = {
        "a": [round(float(s[s.gw == g].fdr_attack.mean()), 1) if len(s[s.gw == g]) else None for g in GWS],
        # Defensive difficulty: how hard it is for THIS club to keep a clean
        # sheet. A separate rating, not the inverse of the attacking one — a
        # trip to a leaky, high-scoring side is easy for your forwards and hard
        # for your defenders at the same time.
        "d": [round(float(s[s.gw == g].fdr_defence.mean()), 1) if len(s[s.gw == g]) else None for g in GWS],
        # Combined difficulty — the mean of the two, i.e. how hard the fixture
        # is overall rather than for one half of the pitch. The engine has
        # always computed this and never shipped it, which is why a player's
        # fixture chips read attack-only: Newcastle at home to Liverpool showed
        # GREEN because Newcastle do create chances at home, while the same
        # fixture is one of the hardest in the calendar once you account for
        # what Liverpool do at the other end. Chips now use this.
        "c": [round(float(s[s.gw == g].fdr_combined.mean()), 1) if len(s[s.gw == g]) else None for g in GWS],
        # CAPS = home fixture, lower-case = away
        "o": [((s[s.gw == g].opponent.iloc[0] if s[s.gw == g].was_home.iloc[0]
                else s[s.gw == g].opponent.iloc[0].lower())
               if len(s[s.gw == g]) else "-") for g in GWS],
    }

# ---- team-level fixture outcomes ------------------------------------------
# The same bivariate-Poisson distribution the player projections rest on,
# summarised per club per gameweek: how likely they are to win, to keep it
# tight, and how many goals the model expects at each end. Computed exactly
# over the scoreline matrix rather than sampled — the simulation and the matrix
# are the same distribution, and the matrix has no Monte Carlo error.
import numpy as _np
from math import exp as _exp, factorial as _fact


def _score_matrix(lam_for, lam_against, n=9):
    ks = _np.arange(n + 1)
    pf = _np.array([_exp(-lam_for) * lam_for ** k / _fact(k) for k in ks])
    pa = _np.array([_exp(-lam_against) * lam_against ** k / _fact(k) for k in ks])
    return _np.outer(pf, pa)


def _outcomes(lam_for, lam_against):
    m = _score_matrix(lam_for, lam_against)
    idx = _np.arange(m.shape[0])
    win = float(m[_np.greater.outer(idx, idx)].sum())
    draw = float(_np.trace(m))
    return {
        "w": round(win, 3), "d": round(draw, 3),
        "l": round(max(0.0, 1.0 - win - draw), 3),
        "cs": round(float(m[:, 0].sum()), 3),
        "gf": round(float(lam_for), 2), "ga": round(float(lam_against), 2),
        # Two or more scored is the state most attacking returns live in.
        "g2": round(float(m[2:, :].sum()), 3),
    }


team_sim = {}
for _t in sorted(set(ftab.team)):
    _s = ftab[(ftab.team == _t) & (ftab.gw.isin(GWS))]
    rows = []
    for _g in GWS:
        _r = _s[_s.gw == _g]
        rows.append(_outcomes(float(_r.lam_for.mean()), float(_r.lam_against.mean()))
                    if len(_r) else None)
    played = [r for r in rows if r]
    team_sim[_t] = {
        "gw": rows,
        # Horizon aggregates: expected league points, clean sheets and goals
        # across the projected window. This is the model's own forecast of the
        # table, which is a fair way to judge whether its team ratings are sane.
        "pts": round(sum(3 * r["w"] + r["d"] for r in played), 1),
        "cs": round(sum(r["cs"] for r in played), 1),
        "gf": round(sum(r["gf"] for r in played), 1),
        "ga": round(sum(r["ga"] for r in played), 1),
    }

from fplab import (config, player_history, ratings as ratings_mod, roles,
                   team_history)
from fplab.config import MIN_EXPECTED_MINUTES

from datetime import datetime, timezone

# Model card, read straight off the constants the engine actually uses.
#
# The methodology page renders this rather than repeating the numbers in JSX.
# Documentation that restates a constant by hand is documentation that will be
# wrong within two commits of somebody re-fitting it; documentation that reads
# the constant cannot be.
_curves = roles.load_curves()
_bt = []
try:
    _bt = json.loads((Path(__file__).resolve().parent.parent
                      / "data" / "live_backtest.json").read_text())
except Exception:
    pass

# Measured horizon degradation, pooled across seasons. Absent until
# `python -m fplab.live_backtest` has run the horizon sweep, in which case the
# app falls back to showing bands without per-horizon error figures — an
# absent measurement is shown as absent, never as a plausible-looking default.
from fplab.sources import DATA as _DATA_DIR
_hc_path = _DATA_DIR / "horizon_decay.csv"
_horizon_curve = []
if _hc_path.exists():
    _hc = pd.read_csv(_hc_path)
    _horizon_curve = [
        {"ahead": int(k), "mae": round(float(v["mae"].mean()), 3),
         "rho": round(float(v["spearman"].mean()), 4)}
        for k, v in _hc.groupby("ahead")
    ]

# International breaks, from real kickoff dates. A gap of twelve days or more
# between one gameweek's first fixture and the next is a break — the domestic
# calendar otherwise runs weekly, and midweek rounds shorten the gap rather
# than lengthen it. These are the weeks a manager gets time to reassess, which
# makes them strategic reset points rather than merely another fixture.
_fx = pd.read_parquet(_DATA_DIR / "fixtures.parquet")
_fx["kickoff"] = pd.to_datetime(_fx["kickoff"], errors="coerce", utc=True)
_first = _fx.dropna(subset=["kickoff"]).groupby("gw")["kickoff"].min().sort_index()
_gap = _first.diff().dt.days
BREAK_GWS = [int(g) for g in _gap[_gap >= 12].index.tolist()]

model = {
    "breaks": BREAK_GWS,
    "seasons_rated": team_history.SEASONS,
    "team_form_halflife": config.TEAM_FORM_HALFLIFE,
    "team_form_window": config.TEAM_FORM_WINDOW,
    "rating_exponent": ratings_mod.RATING_EXPONENT,
    "venue_credibility": ratings_mod.VENUE_CREDIBILITY,
    "fdr_span_sigma": ratings_mod.FDR_SPAN_SIGMA,
    "budget_outfield": roles.BUDGET_OUTFIELD,
    "budget_gk": roles.BUDGET_GK,
    "role_concentration": roles.ROLE_CONCENTRATION,
    "xi_nail_floor": roles.XI_NAIL_FLOOR,
    "xi_nail_floor_gk": roles.XI_NAIL_FLOOR_GK,
    "p_start_exp": round(_curves["p_start_exp"], 4),
    "p_60_exp": round(_curves["p_60_exp"], 4),
    "p_play_exp": round(_curves["p_play_exp"], 4),
    "shrink_k_attack": config.SHRINK_K_ATTACK,
    "shrink_k_defcon": config.SHRINK_K_DEFCON,
    "shrink_k_bps": config.SHRINK_K_BPS,
    # Cross-season rate carrying, and the minutes dynamics fitted alongside it.
    "share_shrink_k": player_history.SHARE_SHRINK_K,
    "season_decay": player_history.SEASON_DECAY,
    "reversion_k": player_history.REVERSION_K,
    "return_ramp": {str(k): list(v) for k, v in config.RETURN_RAMP.items()},
    "xi_floor_halflife": config.XI_FLOOR_HALFLIFE,
    "signing_bed_in_gws": config.SIGNING_BED_IN_GWS,
    "signing_bed_in_start": config.SIGNING_BED_IN_START,
    "pos_budget_share": roles.POS_BUDGET_SHARE,
    "pos_xi_slots": roles.POS_XI_SLOTS,
    "n_rate_mostly_price": (int(players["rate_mostly_price"].sum())
                            if "rate_mostly_price" in players.columns else 0),
    "n_carry_share": (int(players["xg_share_prior"].notna().sum())
                      if "xg_share_prior" in players.columns else 0),
    "assist_inflation": config.FPL_ASSIST_INFLATION,
    "assist_credibility": config.ASSIST_CREDIBILITY,
    "defcon_dispersion": config.DEFCON_DISPERSION,
    "defcon_threshold": {k: v for k, v in config.DEFCON_THRESHOLD.items() if v},
    "goal_points": config.GOAL_POINTS,
    "cs_points": config.CLEAN_SHEET_POINTS,
    "assist_points": config.ASSIST_POINTS,
    "horizon_discount": config.HORIZON_DISCOUNT,
    "horizon_decay": config.HORIZON_CONFIDENCE_DECAY,
    "horizon_bands": [list(b) for b in config.HORIZON_BANDS],
    # The measured curve itself, so the app can state error at a horizon rather
    # than implying one. Pooled over three seasons; see data/horizon_decay.csv.
    "horizon_curve": _horizon_curve,
    "promoted_att": __import__("fplab.promoted", fromlist=["x"]).PROMOTED_ATT,
    "promoted_def": __import__("fplab.promoted", fromlist=["x"]).PROMOTED_DEF,
    "backtest": [{"season": b.get("season"), "n": b.get("n"), "mae": b.get("mae"),
                  "rmse": b.get("rmse"),
                  "spearman": b.get("spearman"), "pearson": b.get("pearson"),
                  "calibration": b.get("calibration_ratio"),
                  "top20": b.get("top20_avg"), "field": b.get("field_avg"),
                  # The decisions a manager actually makes.
                  "capt": b.get("capt_model"), "capt_best": b.get("capt_best"),
                  "capt_field": b.get("capt_field"),
                  "capture": b.get("capt_capture"),
                  "hit5": b.get("hit5"), "hit20": b.get("hit20")}
                 for b in _bt],
    "n_predicted_xi": int(players.get("predicted_xi", pd.Series(dtype=bool)).sum())
                      if "predicted_xi" in players.columns else 0,
}

data = {"gws": GWS, "players": out, "fdr": fd, "promoted": ["COV", "HUL", "IPS"],
        "preseason": preseason, "min_minutes": MIN_EXPECTED_MINUTES,
        "model": model, "team_sim": team_sim,
        # Shown in the app so nobody plans a gameweek off three-week-old prices.
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}
(OUT / "data.json").write_text(json.dumps(data, separators=(",", ":")))

opt = {}
for g in GWS:
    r = pipeline.plan(proj, [g], n_alternatives=0)["best"]
    wk = r["weeks"][0]
    opt[str(g)] = {"squad": [int(i) for i in wk["squad"]], "xp": round(wk["xp"], 1), "cost": wk["cost"]}
r3 = pipeline.plan(proj, GWS[:3], n_alternatives=0)["best"]
opt["h3"] = {"squad": [int(i) for i in r3["squad_ids"]], "xp": round(r3["objective"], 1),
             "cost": r3["weeks"][0]["cost"]}
# The held-squad solve stays at six weeks. Nineteen weeks of per-player binaries
# is a far larger MILP than the horizon justifies — nobody holds one squad for
# half a season, and the weekly solves above already cover the lookahead.
HOLD = GWS[:6]
r6 = pipeline.plan(proj, HOLD, n_alternatives=0, chips=True)["best"]
opt["range"] = {"squad": [int(i) for i in r6["squad_ids"]], "xp": round(r6["objective"], 1),
                "cost": r6["weeks"][0]["cost"], "gws": HOLD,
                "chips": {
                    "bb": next((wk["gw"] for wk in r6["weeks"] if wk["bench_boost"]), None),
                    "tc": next((wk["gw"] for wk in r6["weeks"] if wk["triple_captain"]), None),
                    "tc_player": next((int(wk["captain"]) for wk in r6["weeks"]
                                       if wk["triple_captain"] and wk["captain"]), None),
                }}
(OUT / "optimal.json").write_text(json.dumps(opt, separators=(",", ":")))

print(f"wrote {OUT}/data.json ({len(out)} players) and {OUT}/optimal.json")
