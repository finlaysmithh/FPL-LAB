"""
The rolling transfer planner.

A manager with a squad does not want a squad. They want to know which one or
two players to change this week, what it is worth, and whether it is worth a
hit. That is a different question from "what is the best fifteen", and it has a
different answer — the best fifteen is unreachable from where they are.

Output is a RANKED LIST OF MOVES with the reason attached, not a squad dump. A
suggestion a manager cannot see the logic of is one they will not take.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import optimize
from .config import HORIZON_DISCOUNT, TRANSFER_HIT


def _window(proj: pd.DataFrame, gws: list[int], decay: float) -> pd.DataFrame:
    """Discounted xP per player over the window, plus the per-gameweek table."""
    w = proj[proj["gw"].isin(gws)].pivot_table(
        index="fpl_id", columns="gw", values="xp", fill_value=0.0)
    for g in gws:
        if g not in w.columns:
            w[g] = 0.0
    return w[gws]


def plan_transfers(
    proj: pd.DataFrame,
    squad: list[int],
    gws: list[int],
    *,
    bank: float = 0.0,
    free_transfers: int = 1,
    purchase_prices: dict | None = None,
    decay: float = HORIZON_DISCOUNT,
    max_suggestions: int = 8,
    late_gain_gw: int = 6,
) -> dict:
    """
    Rank single transfers out of `squad` over the window `gws`.

    Every candidate is scored on the DISCOUNTED window gain to the starting XI,
    not to the fifteen — a player who improves your bench improves nothing.
    """
    meta = proj.drop_duplicates("fpl_id").set_index("fpl_id")
    w = _window(proj, gws, decay)
    ids = [i for i in w.index if i in meta.index]
    price = {i: float(meta.at[i, "price"]) for i in ids}
    pos = {i: meta.at[i, "position"] for i in ids}
    club = {i: meta.at[i, "team"] for i in ids}
    name = {i: meta.at[i, "display_name"] for i in ids}
    weights = np.array([decay ** k for k in range(len(gws))])
    # Mean combined fixture difficulty per club across the window, so a move
    # can say WHY it is a gain rather than only how much.
    fdr = {}
    if "fdr_attack" in proj.columns:
        f = proj[proj["gw"].isin(gws)]
        fdr = f.groupby("team")["fdr_attack"].mean().to_dict()

    sell = {}
    for i in squad:
        buy_at = (purchase_prices or {}).get(i, price.get(i, 0.0))
        sell[i] = optimize.selling_price(buy_at, price.get(i, 0.0))

    def xi_value(members: list[int]) -> tuple[float, np.ndarray]:
        """Discounted best-XI-plus-captain value, and the per-gameweek series."""
        per = []
        for k, g in enumerate(gws):
            vals = {i: float(w.at[i, g]) for i in members if i in w.index}
            xi, capt = _best_xi(members, vals, pos)
            per.append(sum(vals.get(i, 0.0) for i in xi) + vals.get(capt, 0.0))
        per = np.array(per)
        return float((per * weights).sum()), per

    base_total, base_per = xi_value(squad)
    club_count = pd.Series([club[i] for i in squad if i in club]).value_counts()

    rows = []
    for out in squad:
        if out not in pos:
            continue
        budget = bank + sell[out]
        for inn in ids:
            if inn in squad or pos.get(inn) != pos[out]:
                continue
            if price[inn] > budget + 1e-9:
                continue
            c = club_count.get(club[inn], 0) - (1 if club[inn] == club[out] else 0)
            if c >= optimize.MAX_PER_CLUB:
                continue
            cand = [i for i in squad if i != out] + [inn]
            tot, per = xi_value(cand)
            gain = tot - base_total
            if gain <= 0.01:
                continue
            wk = per - base_per
            peak = int(np.argmax(wk))
            # Break-even: the gameweek by which the cumulative gain has paid
            # back a -4 hit. `None` means it never does inside the window,
            # which is the answer that stops a bad hit.
            cum = np.cumsum(wk)
            be = next((gws[k] for k in range(len(cum)) if cum[k] >= TRANSFER_HIT),
                      None)
            rows.append({
                "out": out, "out_name": name[out], "out_price": price[out],
                "sell_price": sell[out],
                "in_id": inn, "in_name": name[inn], "in_price": price[inn],
                "position": pos[out],
                "gain": round(gain, 2),
                "gain_after_hit": round(gain - TRANSFER_HIT, 2),
                "peak_gw": gws[peak],
                "peak_gain": round(float(wk[peak]), 2),
                # Where the value sits. A move whose whole edge is in GW6+ is
                # optimising against numbers the horizon fit says we should not
                # lean on, and a free transfer will still be there to make it.
                "share_early": round(float(wk[:min(3, len(wk))].sum()
                                           / wk.sum()) if wk.sum() > 0 else 0.0, 2),
                "break_even_gw": be,
                # The fixture swing driving it: how much easier the incoming
                # player's run is than the outgoing one's, in difficulty points.
                # This is the one-line "why" — a gain with no visible cause is a
                # suggestion a manager will not take.
                "fdr_out": round(float(fdr.get(club[out], np.nan)), 2)
                if club.get(out) in fdr else None,
                "fdr_in": round(float(fdr.get(club[inn], np.nan)), 2)
                if club.get(inn) in fdr else None,
                "in_p_start": float(meta.at[inn, "p_start_gw"])
                if "p_start_gw" in meta.columns else None,
                "cash_left": round(budget - price[inn], 1),
            })

    out_df = pd.DataFrame(rows)
    if out_df.empty:
        return {"moves": [], "base": round(base_total, 2), "gws": gws}

    # Reject moves whose entire edge is late. The horizon fit says a ten-week
    # projection keeps most of its ranking, but a transfer is reversible and a
    # free one arrives every week — so paying now for GW6+ value is buying
    # something still on the shelf.
    late = out_df["peak_gw"] >= late_gain_gw
    only_late = late & (out_df["share_early"] < 0.15)
    out_df["deferred"] = only_late
    keep = out_df[~only_late].sort_values("gain", ascending=False)
    keep = keep.drop_duplicates("out").head(max_suggestions)

    moves = []
    for _, r in keep.iterrows():
        pays = float(r["gain_after_hit"]) > 0
        ps = r["in_p_start"]
        moves.append({
            **{k: (r[k].item() if hasattr(r[k], "item") else r[k]) for k in
               ("out", "out_name", "out_price", "sell_price", "in_id", "in_name",
                "in_price", "position", "gain", "gain_after_hit", "peak_gw",
                "peak_gain", "share_early", "cash_left", "break_even_gw",
                "fdr_out", "fdr_in")},
            "hit_pays": bool(pays),
            # A move can be right in expectation and still arrive with variance
            # the user should be told about before they take it.
            "bench_risk": bool(ps is not None and pd.notna(ps) and ps < 0.70),
            "in_p_start": None if ps is None or pd.isna(ps) else round(float(ps), 3),
        })
    return {
        "moves": moves,
        "base": round(base_total, 2),
        "gws": gws,
        "free_transfers": free_transfers,
        "n_deferred": int(only_late.sum()),
    }


def _best_xi(members, vals, pos):
    from .config import XI_MAX, XI_MIN
    by = {p: sorted([i for i in members if pos.get(i) == p],
                    key=lambda i: -vals.get(i, 0.0))
          for p in ("GK", "DEF", "MID", "FWD")}
    best, best_v = [], -1e9
    for nd in range(XI_MIN["DEF"], XI_MAX["DEF"] + 1):
        for nm in range(XI_MIN["MID"], XI_MAX["MID"] + 1):
            nf = 10 - nd - nm
            if not (XI_MIN["FWD"] <= nf <= XI_MAX["FWD"]):
                continue
            if len(by["DEF"]) < nd or len(by["MID"]) < nm or len(by["FWD"]) < nf \
                    or not by["GK"]:
                continue
            xi = by["GK"][:1] + by["DEF"][:nd] + by["MID"][:nm] + by["FWD"][:nf]
            v = sum(vals.get(i, 0.0) for i in xi)
            if v > best_v:
                best, best_v = xi, v
    capt = max(best, key=lambda i: vals.get(i, 0.0)) if best else None
    return best, capt


def roll_or_use(planner_result: dict, decay: float = HORIZON_DISCOUNT) -> dict:
    """
    Take the best move now, or bank the transfer and take two next week?

    Banking is worth the SECOND transfer's option value minus the points the
    best move would have returned this week. The honest comparison, because a
    planner that only ever says "transfer" is a planner that costs its user
    four points a fortnight.
    """
    moves = planner_result.get("moves") or []
    if not moves:
        return {"verdict": "roll", "why": "Nothing in the squad is worth a move."}
    best = moves[0]
    this_week = best["peak_gain"] if best["peak_gw"] == planner_result["gws"][0] else 0.0
    # Rolling forgoes this week's slice of the gain but keeps the move available
    # and adds a second transfer next week.
    forgone = round(float(this_week), 2)
    return {
        "verdict": "use" if forgone > 0.6 else "roll",
        "best": best,
        "forgone_by_rolling": forgone,
        "why": (f"{best['in_name']} is worth {best['gain']:.1f} over the window but only "
                f"{forgone:.1f} of it lands in GW{planner_result['gws'][0]}. "
                + ("Take it now." if forgone > 0.6 else
                   "Bank the transfer — the move keeps, and two next week buys more.")),
    }
