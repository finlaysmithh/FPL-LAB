"""
`explain(player_id, gw)` — every number behind one projection.

The engine is a chain: raw rates -> credibility blend -> squad conservation ->
per-gameweek minutes -> fixture lambdas -> nine scoring components. When a
projection looks wrong, the useful question is never "is the total wrong" but
"which link in that chain is wrong", and until now answering it meant adding
print statements to four modules.

This returns the whole chain for one player-gameweek as a flat dict: every xP
component, and every input that produced it. Nothing here recomputes anything —
it reads the same pipeline the app ships, so a number that appears here is by
construction the number that appears in the app.

    python -m fplab.explain 426 1        # one player
    python -m fplab.explain --price 5.0 --pos DEF
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from . import pipeline, roles


_CACHE: dict = {}


def _context(gws: list[int]):
    """Build (and memoise) the projection context for a set of gameweeks."""
    key = tuple(gws)
    if key in _CACHE:
        return _CACHE[key]
    players, matchlog, fixtures = pipeline.load()
    proj, rt, ftab = pipeline.build_projections(players, matchlog, fixtures, gws)
    mbg = proj.attrs.get("minutes_by_gw", {})
    ctx = {"players": players, "fixtures": fixtures, "proj": proj,
           "ratings": rt, "ftab": ftab, "minutes_by_gw": mbg,
           "league_mu": float(matchlog["xg_for"].mean())}
    _CACHE[key] = ctx
    return ctx


# The nine scoring terms, in the order the docstring of xpts.py lists them.
COMPONENTS = [
    ("appearance", "xp_appearance"), ("goals", "xp_goals"),
    ("assists", "xp_assists"), ("clean_sheet", "xp_cs"),
    ("defcon", "xp_defcon"), ("bonus", "xp_bonus"),
    ("saves", "xp_saves"), ("conceded", "xp_conceded"),
    ("cards", "xp_cards"),
]


def explain(player_id: int, gw: int, ctx: dict | None = None) -> dict:
    """
    Every xP term for one player-gameweek, plus the inputs behind each.

    Returns a flat dict. `None` for a field means the pipeline genuinely does
    not carry it for this player — an absent number, never a zero standing in
    for one.
    """
    ctx = ctx or _context([gw])
    proj, players = ctx["proj"], ctx["players"]

    row = proj[(proj["fpl_id"] == player_id) & (proj["gw"] == gw)]
    if row.empty:
        raise KeyError(f"no projection for player {player_id} in GW{gw}")
    r = row.iloc[0]

    p = players[players["fpl_id"] == player_id]
    p = p.iloc[0] if len(p) else pd.Series(dtype=object)

    # ---- fixture side -----------------------------------------------------
    ft = ctx["ftab"]
    fx = ft[(ft["team"] == r["team"]) & (ft["gw"] == gw)]
    lam_own = float(fx["lam_for"].mean()) if len(fx) else None
    lam_opp = float(fx["lam_against"].mean()) if len(fx) else None
    cs_prob = float(fx["cs_prob"].mean()) if len(fx) else None

    # ---- minutes side -----------------------------------------------------
    mrow = None
    frame = ctx["minutes_by_gw"].get(gw)
    if frame is not None:
        idx = players.index[players["fpl_id"] == player_id]
        if len(idx) and idx[0] in frame.index:
            mrow = frame.loc[idx[0]]

    def g(series, key, cast=float):
        v = series.get(key) if series is not None else None
        try:
            return None if v is None or pd.isna(v) else cast(v)
        except (TypeError, ValueError):
            return None

    # Credibility weight the blend actually used: w = n90 / (n90 + K).
    n90 = g(p, "n90_now") or 0.0
    from .config import SHRINK_K_ATTACK
    cred_w = n90 / (n90 + SHRINK_K_ATTACK) if (n90 + SHRINK_K_ATTACK) else 0.0

    team_xg90 = float(ctx["league_mu"] * ctx["ratings"].at[r["team"], "att"]) \
        if r["team"] in ctx["ratings"].index else None
    xg90_blend = g(p, "xg90_prior")

    out = {
        "player": str(p.get("web_name", player_id)),
        "fpl_id": int(player_id), "gw": int(gw),
        "team": r["team"], "position": r["position"],
        "price": g(p, "price"), "opponent": r.get("opponent"),
        "xp": float(r["xp"]),
        "xp_if_starts": g(r, "xp_start"),
    }
    for name, col in COMPONENTS:
        out[name] = g(r, col)

    out.update({
        # --- minutes chain ---
        "minutes_path": (str(p.get("minutes_flag")) or "measured"),
        "prior_minutes": g(p, "prior_minutes"),
        "mins_share_prior": g(p, "mins_share_prior"),
        "mins_per_start": g(p, "mins_per_start_prior"),
        "predicted_xi": bool(p.get("predicted_xi", False)),
        "nailed": g(mrow, "nailed"),
        "conservation_lambda": g(mrow, "role_lambda"),
        "exp_mins": g(r, "exp_mins_gw"),
        "p_start": g(r, "p_start_gw"),
        "p_60": g(r, "p60_gw"),
        "p_play": g(mrow, "p_play"),
        # --- rate chain ---
        # `xG90_raw` is this season's own measured rate, which is correctly
        # 0.0 pre-season — it is not a missing number, it is an unplayed one.
        # `xG90_hist` is what the player's OWN multi-season record says, and it
        # is the one to read against `xG90_blended`: when they differ and
        # `rate_is_price_implied` is true, the player's history has been thrown
        # away and replaced with the median of his price band, which is the
        # single most misleading thing this engine can do to a projection.
        "xG90_raw": g(p, "xg90_now"),
        "xG90_hist": g(p, "_hist_xg90"),
        "rate_is_price_implied": bool(p.get("price_implied_prior", False)),
        "career_n90": g(p, "career_n90"),
        "xG90_blended": xg90_blend,
        "xA90_blended": g(p, "xa90_prior"),
        "bps90_blended": g(p, "bps90_prior"),
        "defcon90_blended": g(p, "defcon90_prior"),
        "credibility_w": round(cred_w, 4),
        "hist_seasons": g(p, "hist_seasons"),
        # --- fixture chain ---
        "team_xg90": team_xg90,
        "share": (xg90_blend / team_xg90) if (xg90_blend and team_xg90) else None,
        "lambda_own": lam_own,
        "lambda_opp": lam_opp,
        "cs_prob": cs_prob,
        "fdr_attack": g(r, "fdr_attack"),
        "fdr_defence": g(r, "fdr_defence"),
        # --- availability ---
        "status": str(p.get("status", "a")),
        "news": (str(p.get("news")) or None) if pd.notna(p.get("news")) else None,
    })
    return out


def format_explain(d: dict) -> str:
    """Human-readable rendering, grouped by stage of the chain."""
    L = [f"{d['player']}  ({d['team']} {d['position']}, £{d['price']}m)  "
         f"GW{d['gw']} v {d['opponent']}",
         f"  xP {d['xp']:.3f}"
         + (f"   ·   xP if he starts {d['xp_if_starts']:.3f}"
            if d.get("xp_if_starts") is not None else "")]

    L.append("\n  COMPONENTS")
    total = 0.0
    for name, _ in COMPONENTS:
        v = d.get(name)
        if v is None:
            continue
        total += v
        L.append(f"    {name:<12} {v:+7.3f}")
    L.append(f"    {'sum':<12} {total:+7.3f}")

    L.append("\n  MINUTES")
    for k in ("minutes_path", "prior_minutes", "mins_share_prior",
              "mins_per_start", "predicted_xi", "nailed",
              "conservation_lambda", "exp_mins", "p_start", "p_60", "p_play"):
        v = d.get(k)
        L.append(f"    {k:<20} {v if not isinstance(v, float) else round(v, 4)}")

    L.append("\n  RATES")
    for k in ("xG90_raw", "xG90_hist", "xG90_blended", "rate_is_price_implied",
              "career_n90", "xA90_blended", "bps90_blended",
              "defcon90_blended", "credibility_w", "hist_seasons"):
        v = d.get(k)
        L.append(f"    {k:<20} {v if not isinstance(v, float) else round(v, 4)}")

    L.append("\n  FIXTURE")
    for k in ("team_xg90", "share", "lambda_own", "lambda_opp", "cs_prob",
              "fdr_attack", "fdr_defence"):
        v = d.get(k)
        L.append(f"    {k:<20} {v if not isinstance(v, float) else round(v, 4)}")

    if d.get("status") != "a" or d.get("news"):
        L.append(f"\n  AVAILABILITY  status={d['status']}  news={d.get('news')}")
    return "\n".join(L)


def cohort(price: float, position: str, gws: list[int]) -> pd.DataFrame:
    """Every player at exactly this price and position, with horizon xP."""
    ctx = _context(gws)
    players, proj = ctx["players"], ctx["proj"]
    sel = players[(players["price"] == price) & (players["position"] == position)]
    tot = proj.groupby("fpl_id")["xp"].sum()
    rows = []
    for p in sel.itertuples():
        d = explain(int(p.fpl_id), gws[0], ctx)
        d["horizon_xp"] = float(tot.get(p.fpl_id, np.nan))
        rows.append(d)
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).sort_values("horizon_xp", ascending=False)


def main() -> None:
    ap = argparse.ArgumentParser(description="Explain an xP projection")
    ap.add_argument("player_id", nargs="?", type=int)
    ap.add_argument("gw", nargs="?", type=int, default=1)
    ap.add_argument("--price", type=float)
    ap.add_argument("--pos", default="DEF")
    ap.add_argument("--gws", default="1-19")
    a = ap.parse_args()

    lo, _, hi = a.gws.partition("-")
    gws = list(range(int(lo), int(hi or lo) + 1))

    if a.price is not None:
        df = cohort(a.price, a.pos, gws)
        if df.empty:
            print(f"no {a.pos} at exactly £{a.price}m")
            return
        cols = ["player", "team", "horizon_xp", "xp", "xp_if_starts", "exp_mins",
                "p_start", "p_60", "nailed", "conservation_lambda",
                "xG90_blended", "minutes_path"]
        show = df[cols].copy()
        for c in show.select_dtypes("float").columns:
            show[c] = show[c].round(3)
        print(f"{a.pos} priced at exactly £{a.price}m — GW{gws[0]}-{gws[-1]}\n")
        print(show.to_string(index=False))
        h = df["horizon_xp"].dropna()
        print(f"\n  n = {len(h)}"
              f"   mean {h.mean():.2f}   sd {h.std(ddof=1):.2f}"
              f"   min {h.min():.1f}   max {h.max():.1f}"
              f"   spread {h.max() - h.min():.1f}")
        return

    if a.player_id is None:
        ap.error("give a player_id, or --price with --pos")
    print(format_explain(explain(a.player_id, a.gw, _context([a.gw]))))


if __name__ == "__main__":
    main()
