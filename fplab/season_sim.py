"""
Realised-points simulation: what a manager following the optimiser would have
actually scored.

Every other number in this project is measured against a projection. This one
is not. A transfer-aware optimiser ALWAYS looks better on projected points,
because projected points are the thing it maximises — quoting that as evidence
is circular. The only honest test is to follow each policy through a real
season, take the transfers it recommends, and count what the players it chose
actually scored.

Three policies, same projections, same starting squad:

  never      buy a squad in the first gameweek and never touch it again
  fixed15    re-solve the best static 15 each week but never transfer
             (a control: isolates projection drift from transfer value)
  transfer   one free transfer a week, banked up to the cap, no hits

The projections come from `live_backtest.walk_forward`, which builds each
gameweek from data available strictly before it, so the manager being
simulated never sees the future.

WHAT THIS DOES NOT MODEL, stated rather than buried: real price changes (so
squad value is frozen at the season-opening price), chips, and the injury news
a real manager reacts to mid-week. The first two make every policy slightly
optimistic in the same direction; the third is the reason a real manager
transfers more than this simulation does.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import MAX_PER_CLUB, SQUAD_QUOTA, SQUAD_SIZE, XI_MAX, XI_MIN


def _best_xi(squad: list[int], vals: dict, pos: dict) -> tuple[list[int], int]:
    """Highest-scoring legal XI from a 15, plus the captain."""
    by = {p: sorted([i for i in squad if pos.get(i) == p],
                    key=lambda i: -vals.get(i, 0.0)) for p in SQUAD_QUOTA}
    best, best_v = None, -1e9
    for nd in range(XI_MIN["DEF"], XI_MAX["DEF"] + 1):
        for nm in range(XI_MIN["MID"], XI_MAX["MID"] + 1):
            nf = 10 - nd - nm
            if not (XI_MIN["FWD"] <= nf <= XI_MAX["FWD"]):
                continue
            if len(by["DEF"]) < nd or len(by["MID"]) < nm or len(by["FWD"]) < nf:
                continue
            xi = by["GK"][:1] + by["DEF"][:nd] + by["MID"][:nm] + by["FWD"][:nf]
            if len(xi) != 11:
                continue
            v = sum(vals.get(i, 0.0) for i in xi)
            if v > best_v:
                best, best_v = xi, v
    if best is None:
        return [], None
    capt = max(best, key=lambda i: vals.get(i, 0.0))
    return best, capt


def _greedy_squad(cand: pd.DataFrame, budget: float = 100.0) -> list[int]:
    """
    A legal 15 by value density, then upgraded while budget allows.

    Deliberately greedy rather than exact: this picks the STARTING squad only,
    it is identical for all three policies, and the comparison between policies
    is unaffected by the common starting point.
    """
    squad, spend = [], 0.0
    per_pos = {p: 0 for p in SQUAD_QUOTA}
    per_club: dict = {}
    # The n CHEAPEST DISTINCT players per position, not n copies of the single
    # cheapest. Using the minimum price times the count understates what a
    # squad still has to buy — the £3.8 keeper can only be bought once, so a
    # plan that assumes two of him overspends by exactly the gap to the next
    # one and lands a player short with £0.1m of headroom.
    ladder = {p: sorted(cand[cand["position"] == p]["price"].tolist()) or [4.0]
              for p in SQUAD_QUOTA}

    def room(p_now: str, price_now: float) -> bool:
        """Can the squad still be completed legally after taking this player?"""
        need = {p: SQUAD_QUOTA[p] - per_pos.get(p, 0) for p in SQUAD_QUOTA}
        need[p_now] -= 1
        floor = 0.0
        for p, n in need.items():
            if n <= 0:
                continue
            # Skip prices already consumed at this position, approximately, by
            # taking the n cheapest beyond those already bought.
            taken = per_pos.get(p, 0) + (1 if p == p_now else 0)
            floor += sum(ladder[p][taken:taken + n])
        return spend + price_now + floor <= budget + 1e-9

    def take(r) -> bool:
        nonlocal spend
        if per_pos.get(r.position, 0) >= SQUAD_QUOTA.get(r.position, 0):
            return False
        if per_club.get(r.team, 0) >= MAX_PER_CLUB:
            return False
        if not room(r.position, r.price):
            return False
        squad.append(r.fpl_id)
        spend += r.price
        per_pos[r.position] += 1
        per_club[r.team] = per_club.get(r.team, 0) + 1
        return True

    for r in cand.sort_values("v", ascending=False).itertuples():
        if len(squad) == SQUAD_SIZE:
            break
        take(r)
    # Backfill anything the value pass could not afford, cheapest first. Without
    # this the builder stalls a couple of players short whenever the expensive
    # end of the board eats the budget before the quotas are met.
    if len(squad) < SQUAD_SIZE:
        for r in cand.sort_values("price").itertuples():
            if len(squad) == SQUAD_SIZE:
                break
            if r.fpl_id in squad:
                continue
            take(r)
    # Last resort: the completion floor above uses each position's GLOBAL
    # cheapest, which can be unreachable when those players sit at clubs
    # already holding three. Drop the forecast and check the budget directly.
    if len(squad) < SQUAD_SIZE:
        for r in cand.sort_values("price").itertuples():
            if len(squad) == SQUAD_SIZE:
                break
            if (r.fpl_id in squad
                    or per_pos.get(r.position, 0) >= SQUAD_QUOTA.get(r.position, 0)
                    or per_club.get(r.team, 0) >= MAX_PER_CLUB
                    or spend + r.price > budget + 1e-9):
                continue
            squad.append(r.fpl_id)
            spend += r.price
            per_pos[r.position] += 1
            per_club[r.team] = per_club.get(r.team, 0) + 1
    return squad


def simulate(res: pd.DataFrame, start_gw: int | None = None,
             free_transfer_cap: int = 5) -> pd.DataFrame:
    """Run all three policies over the frame `live_backtest` produced."""
    res = res.copy()
    gws = sorted(res["gw"].unique())
    if start_gw:
        gws = [g for g in gws if g >= start_gw]
    meta = res.drop_duplicates("fpl_id").set_index("fpl_id")
    pos = meta["position"].to_dict()

    # Horizon value for the opening squad: mean projection over the first five
    # gameweeks, which is what a manager building a team would look at.
    head = res[res["gw"].isin(gws[:5])]
    cand = (head.groupby("fpl_id")
            .agg(v=("xp", "mean"), price=("price", "first"),
                 position=("position", "first"), team=("team", "first"))
            .reset_index())
    cand = cand[cand["price"] > 0]
    opening = _greedy_squad(cand)
    if len(opening) < SQUAD_SIZE:
        raise RuntimeError(f"could not build a legal opening squad "
                           f"({len(opening)}/{SQUAD_SIZE})")

    # A naive manager who never models anything: spend the budget on the most
    # expensive legal fifteen and leave it alone. This is the baseline that
    # says whether the projections are doing any work at all — price is the
    # market's own ranking, freely available, and a model that cannot beat it
    # is not earning its keep.
    naive_cand = cand.copy()
    naive_cand["v"] = naive_cand["price"]
    naive = _greedy_squad(naive_cand)

    squads = {"fixed15": list(opening), "transfer": list(opening)}
    if len(naive) == SQUAD_SIZE:
        squads["naive_price"] = naive
    # Cash left over from the opening build. Every transfer has to fund itself
    # from this, exactly as a real manager's does.
    price0 = meta["price"].to_dict()
    bank = round(100.0 - sum(price0.get(i, 0.0) for i in opening), 1)
    bank_ft = 0
    rows = []

    for g in gws:
        wk = res[res["gw"] == g]
        xp = dict(zip(wk["fpl_id"], wk["xp"]))
        act = dict(zip(wk["fpl_id"], wk["actual"]))

        # --- transfer policy: one free a week, banked, never take a hit ----
        if g != gws[0]:
            bank_ft = min(bank_ft + 1, free_transfer_cap)
            for _ in range(bank_ft):
                sq = squads["transfer"]
                cur_pos = {i: pos.get(i) for i in sq}
                clubs = pd.Series([meta.at[i, "team"] for i in sq]).value_counts()
                # Swap the worst holder for the best available at his position,
                # judged on projections only — never on what actually happened.
                best_gain, best_move = 0.0, None
                for out in sq:
                    p = cur_pos[out]
                    out_price = float(meta.at[out, "price"])
                    for r in wk.itertuples():
                        if r.fpl_id in sq or r.position != p:
                            continue
                        c = clubs.get(r.team, 0)
                        if r.team != meta.at[out, "team"] and c >= MAX_PER_CLUB:
                            continue
                        # BUDGET. Without this the policy simply accumulates
                        # the most expensive player at every position and the
                        # comparison is meaningless — it is not beating
                        # fixed-15, it is spending money fixed-15 never had.
                        if r.price - out_price > bank + 1e-9:
                            continue
                        gain = xp.get(r.fpl_id, 0.0) - xp.get(out, 0.0)
                        if gain > best_gain:
                            best_gain, best_move = gain, (out, r.fpl_id)
                if best_move and best_gain > 0.05:
                    o, i = best_move
                    bank -= float(meta.at[i, "price"]) - float(meta.at[o, "price"])
                    squads["transfer"][squads["transfer"].index(o)] = i
                    bank_ft -= 1
                else:
                    break

        for name, sq in squads.items():
            xi, capt = _best_xi(sq, xp, pos)
            if not xi:
                continue
            pts = sum(act.get(i, 0) for i in xi) + act.get(capt, 0)
            rows.append({"gw": g, "policy": name, "points": pts,
                         "projected": round(sum(xp.get(i, 0) for i in xi)
                                            + xp.get(capt, 0), 2)})
    return pd.DataFrame(rows)
