"""
Multi-period squad optimisation.

The fix over v1: transfers are now decision variables PER GAMEWEEK, with a
proper free-transfer bank. v1 only constrained the aggregate difference from
your current squad, so it could never answer the actual question — "roll this
week and take a hit in GW6, or move now?".

Formulation
-----------
For each player i and gameweek g:

    own[i,g]   binary   in squad during gw g
    buy[i,g]   binary   transferred in before gw g
    sell[i,g]  binary   transferred out before gw g
    start[i,g] binary   in the XI
    capt[i,g]  binary   captain

Squad continuity:

    own[i,g] = own[i,g-1] + buy[i,g] - sell[i,g]

Free-transfer bank (integer, 0..5):

    ft[g] <= ft[g-1] + 1 - transfers[g-1] + hits[g-1]
    hits[g] >= transfers[g] - ft[g]

Objective:

    max  sum_g d^g * ( sum_i xp[i,g]*(start[i,g] + capt[i,g])
                     + BENCH_W * sum_i xp[i,g]*(own[i,g]-start[i,g]) )
         - 4 * sum_g hits[g]

Budget is enforced every gameweek, so the optimiser cannot buy a £15m striker
in GW1 and pretend it is free in GW4.

Customisation
-------------
must_include / must_exclude are hard constraints, so you can force your own
picks and let the model optimise around them — "I'm keeping Haaland and
Salah, build me the best rest". Ownership screens let you hunt differentials
or deliberately avoid the template.
"""
from __future__ import annotations

import pandas as pd
import pulp

from .config import (
    BUDGET, MAX_FREE_TRANSFERS, MAX_PER_CLUB, MIN_EXPECTED_MINUTES,
    SQUAD_QUOTA, SQUAD_SIZE, TRANSFER_HIT, XI_MAX, XI_MIN, XI_SIZE,
)

# ---- bench value: autosub expectation, not a flat insurance discount -------
# A bench player scores for you only when an outfield starter fails to play AND
# the autosub reaches his slot AND he himself played. The last clause needs no
# extra term: `xp` is already unconditional, so a fourth-choice defender who
# never appears carries xp ~ 0 and is worth nothing here by construction. That
# is why the objective multiplies the SLOT probability by the player's own xp
# rather than by a price or a position.
#
# Slot probabilities are the Poisson-binomial of the starting XI's own P(start),
# measured on the solved optimal squad (mean outfield P(start) 0.927):
#
#     P(>= 1 outfield starter blanks) = 0.542   -> bench slot 1
#     P(>= 2)                         = 0.158   -> bench slot 2
#     P(>= 3)                         = 0.026   -> bench slot 3
#     P(GK1 blanks)                   = 0.013   -> bench keeper
#
# The flat 0.12 this replaces was wrong in both directions at once: it valued
# the first bench slot at less than a quarter of its worth, and the third at
# six times. Ordering the bench is most of the value, and a single number
# cannot express it.
AUTOSUB_SLOT_P = (0.542, 0.158, 0.026)
BENCH_GK_WEIGHT = 0.013  # P(first-choice keeper does not play)

# Retained as the fallback weight when bench ordering is switched off, and as
# the mean of the three slot probabilities so the two modes are comparable.
BENCH_WEIGHT = round(sum(AUTOSUB_SLOT_P) / len(AUTOSUB_SLOT_P), 3)


def selling_price(purchase: float, current: float) -> float:
    """
    What FPL actually pays you for a player, in millions.

    The rule: you get your purchase price back, plus HALF of any rise, and the
    half is rounded DOWN to the nearest £0.1m. A fall is taken in full — there
    is no cushion on the way down.

        bought 5.0, now 5.3  ->  rise 0.3, half 0.15, rounded down 0.1  ->  5.1
        bought 5.0, now 5.4  ->  rise 0.4, half 0.20                    ->  5.2
        bought 5.0, now 5.5  ->  rise 0.5, half 0.25, rounded down 0.2  ->  5.2
        bought 5.0, now 4.7  ->  fall taken in full                     ->  4.7

    Getting this wrong is not a rounding detail: it shifts the budget of every
    plan involving a risen player, so a transfer the model calls affordable may
    not be, and one it rejects may have been fine. Prices are held in tenths
    internally because 0.1 is not representable in binary and the floor is
    exactly where that error would land.
    """
    p10 = int(round(float(purchase) * 10))
    c10 = int(round(float(current) * 10))
    if c10 <= p10:
        return c10 / 10.0
    return (p10 + (c10 - p10) // 2) / 10.0


def squad_value(squad: list[int], purchase: dict, current: dict) -> float:
    """Total sale value of a squad — what the bank would hold if it were sold."""
    return round(sum(selling_price(purchase.get(i, current.get(i, 0.0)),
                                   current.get(i, 0.0)) for i in squad), 1)


def solve(
    proj: pd.DataFrame,
    gws: list[int],
    *,
    budget: float = BUDGET,
    bank: float = 0.0,
    current_squad: list[int] | None = None,
    free_transfers: int = 1,
    max_hits_total: int = 0,
    wildcard_gw: int | None = None,
    must_include: list[int] | None = None,
    must_exclude: list[int] | None = None,
    max_per_club: int = MAX_PER_CLUB,
    discount: float = 0.88,
    forbid: list[list[int]] | None = None,
    min_ownership: float | None = None,
    max_ownership: float | None = None,
    allow_transfers: bool | None = None,
    chips: bool = False,
    min_expected_minutes: float = MIN_EXPECTED_MINUTES,
    autosub: bool = True,
    purchase_prices: dict | None = None,
    pool_size: int | None = None,
    time_limit: int = 60,
) -> dict:
    """
    allow_transfers
        None (default): True when you supply current_squad (plan transfers),
        False for a free build (return ONE squad optimised across the whole
        horizon). Set explicitly to override — a free build with transfers
        enabled answers "best GW1 squad plus the transfer path from there".

    chips
        When True, Bench Boost and Triple Captain become decision variables:
        at most one week each across the horizon, chosen by the solver. In
        the BB week the bench scores its full xP (not the insurance weight);
        in the TC week the captain scores 3x instead of 2x. Free Hit is NOT
        a variable here — a Free Hit squad is by definition the single-week
        optimal, which `solve(proj, [g])` already computes exactly.
    """
    xp = proj.pivot_table(index="fpl_id", columns="gw", values="xp", fill_value=0.0)
    for g in gws:
        if g not in xp.columns:
            xp[g] = 0.0
    xp = xp[gws]
    cols = ["display_name", "team", "position", "price", "provisional", "ownership"]
    for c in ("exp_mins", "status"):
        if c in proj.columns:
            cols.append(c)
    meta = proj.drop_duplicates("fpl_id").set_index("fpl_id")[cols].loc[xp.index]
    ids = list(xp.index)

    # Ownership screen (differential hunting / template avoidance).
    keep = set(must_include or [])

    # Minutes eligibility gate. A player projected under `min_expected_minutes`
    # is dropped from the pool entirely rather than merely down-weighted: his
    # per-90 rates are the least trustworthy numbers in the model, and at that
    # minutes level the appearance and clean-sheet terms — which key off P(60),
    # not raw minutes — barely fire. must_include always wins; that box and
    # data/overrides.csv are where a view the model lacks belongs.
    gated = []
    if min_expected_minutes and "exp_mins" in meta.columns:
        em = pd.to_numeric(meta["exp_mins"], errors="coerce")
        gated = [i for i in ids
                 if i not in keep and pd.notna(em.at[i]) and em.at[i] < min_expected_minutes]

    # Injured, suspended and unavailable players never enter an optimal squad.
    # The minutes model already multiplies their xP toward zero, but "nearly
    # zero points" still leaves a cheap body the solver will happily park on a
    # bench. FPL status is categorical, so treat it that way.
    unavailable = []
    if "status" in meta.columns:
        st = meta["status"].astype(str)
        unavailable = [i for i in ids if i not in keep and st.at[i] in ("i", "s", "u")]
        gated = sorted(set(gated) | set(unavailable))

    if gated:
        ids = [i for i in ids if i not in set(gated)]
    if min_ownership is not None:
        ids = [i for i in ids if meta.at[i, "ownership"] >= min_ownership or i in keep]
    if max_ownership is not None:
        ids = [i for i in ids if meta.at[i, "ownership"] <= max_ownership or i in keep]
    # --- pool pre-filter, for tractability -------------------------------
    # A multi-period model over 587 players does not solve in a time anybody
    # will wait for. Rank by horizon xP per million and keep the top slice, but
    # never drop a player the manager already owns or has locked: the model has
    # to be able to describe the squad it starts from, or it reports Infeasible
    # for a squad that plainly exists. Positional quotas mean the filter is
    # applied WITHIN position — a global cut starves the cheap-defender end and
    # makes a legal fifteen impossible.
    if pool_size and len(ids) > pool_size:
        protect = set(current_squad or []) | set(must_include or [])
        tot = xp.sum(axis=1)
        ppm = tot / meta["price"].clip(lower=0.1)
        keep_ids = set(protect)
        for pos, n in SQUAD_QUOTA.items():
            pos_ids = [i for i in ids if meta.at[i, "position"] == pos]
            share = max(n * 4, int(pool_size * len(pos_ids) / max(len(ids), 1)))
            ranked = sorted(pos_ids, key=lambda i: -ppm.get(i, 0.0))[:share]
            keep_ids.update(ranked)
        ids = [i for i in ids if i in keep_ids]

    xp, meta = xp.loc[ids], meta.loc[ids]

    P = pulp.LpProblem("fpl_multi", pulp.LpMaximize)
    G = list(gws)
    g0 = G[0]

    own = pulp.LpVariable.dicts("own", (ids, G), cat="Binary")
    buy = pulp.LpVariable.dicts("buy", (ids, G), cat="Binary")
    sell = pulp.LpVariable.dicts("sell", (ids, G), cat="Binary")
    start = pulp.LpVariable.dicts("st", (ids, G), cat="Binary")
    capt = pulp.LpVariable.dicts("cp", (ids, G), cat="Binary")
    # Bench ORDER, one binary per outfield bench slot. Without it every benched
    # player is worth the same, which is the single biggest thing a flat bench
    # weight gets wrong: the first slot is used in 54% of gameweeks and the
    # third in 3%.
    SLOTS = list(range(len(AUTOSUB_SLOT_P)))
    bench = pulp.LpVariable.dicts("bn", (ids, G, SLOTS), cat="Binary") \
        if autosub else None
    hits = pulp.LpVariable.dicts("hit", G, lowBound=0, cat="Integer")
    ft = pulp.LpVariable.dicts("ft", G, lowBound=0, upBound=MAX_FREE_TRANSFERS, cat="Integer")

    # Chip decision variables. z_* are the linearised products (continuous is
    # sufficient: both have positive objective coefficients and are capped by
    # binaries, so the solver drives them to min(cap, cap) on its own).
    if chips:
        bb = pulp.LpVariable.dicts("bb", G, cat="Binary")
        tc = pulp.LpVariable.dicts("tc", G, cat="Binary")
        z_bb = pulp.LpVariable.dicts("zbb", (ids, G), lowBound=0, upBound=1)
        z_tc = pulp.LpVariable.dicts("ztc", (ids, G), lowBound=0, upBound=1)
        P += pulp.lpSum(bb[g] for g in G) <= 1
        P += pulp.lpSum(tc[g] for g in G) <= 1

    price = {i: float(meta.at[i, "price"]) for i in ids}
    # Selling prices, for players the manager already owns. Anyone not in the
    # map sells at his current price, which is exactly right for a player who
    # has not moved and for a fresh build with no purchase history.
    sell_price = {}
    if purchase_prices:
        for i in ids:
            if i in purchase_prices:
                sell_price[i] = selling_price(purchase_prices[i], price[i])
    have = set(current_squad or [])
    free_build = current_squad is None
    if allow_transfers is None:
        allow_transfers = not free_build

    for g in G:
        # --- squad shape ---
        P += pulp.lpSum(own[i][g] for i in ids) == SQUAD_SIZE
        for pos, n in SQUAD_QUOTA.items():
            P += pulp.lpSum(own[i][g] for i in ids if meta.at[i, "position"] == pos) == n
        for club in meta["team"].unique():
            P += pulp.lpSum(own[i][g] for i in ids if meta.at[i, "team"] == club) <= max_per_club

        # --- budget, enforced every week ---
        # Two different prices are in play and conflating them is the classic
        # way an FPL tool recommends a transfer the manager cannot make. A
        # player you ALREADY OWN is worth his selling price (purchase plus half
        # the rise, rounded down); a player you are BUYING costs his full
        # current price. When no purchase prices are supplied the two coincide,
        # which is the correct behaviour for a fresh build.
        if sell_price:
            P += (pulp.lpSum(own[i][g] * price[i] for i in ids)
                  - pulp.lpSum(sell[i][g] * (price[i] - sell_price.get(i, price[i]))
                               for i in ids)) <= budget + bank
        else:
            P += pulp.lpSum(own[i][g] * price[i] for i in ids) <= budget + bank

        # --- formation ---
        P += pulp.lpSum(start[i][g] for i in ids) == XI_SIZE
        for pos in SQUAD_QUOTA:
            sel = [start[i][g] for i in ids if meta.at[i, "position"] == pos]
            P += pulp.lpSum(sel) >= XI_MIN[pos]
            P += pulp.lpSum(sel) <= XI_MAX[pos]
        P += pulp.lpSum(capt[i][g] for i in ids) == 1

        # --- bench order ---
        # Exactly one outfield player per slot, each an owned non-starter, and
        # nobody in two slots at once. A keeper is excluded: he can only be
        # subbed for the other keeper, which is priced separately.
        if autosub:
            out_ids = [i for i in ids if meta.at[i, "position"] != "GK"]
            for s in SLOTS:
                P += pulp.lpSum(bench[i][g][s] for i in out_ids) == 1
                for i in ids:
                    if meta.at[i, "position"] == "GK":
                        P += bench[i][g][s] == 0
                    else:
                        P += bench[i][g][s] <= own[i][g] - start[i][g]
            for i in out_ids:
                P += pulp.lpSum(bench[i][g][s] for s in SLOTS) <= 1

        for i in ids:
            P += start[i][g] <= own[i][g]
            P += capt[i][g] <= start[i][g]
            if chips:
                P += z_bb[i][g] <= own[i][g] - start[i][g]
                P += z_bb[i][g] <= bb[g]
                P += z_tc[i][g] <= capt[i][g]
                P += z_tc[i][g] <= tc[g]

        # --- continuity ---
        for i in ids:
            if g == g0:
                if free_build:
                    P += buy[i][g] == 0
                    P += sell[i][g] == 0
                else:
                    P += own[i][g] == (1 if i in have else 0) + buy[i][g] - sell[i][g]
            else:
                pg = G[G.index(g) - 1]
                if allow_transfers or (wildcard_gw is not None and g == wildcard_gw):
                    P += own[i][g] == own[i][pg] + buy[i][g] - sell[i][g]
                else:
                    # Static squad: hold the same 15 across the horizon.
                    P += own[i][g] == own[i][pg]
                    P += buy[i][g] == 0
                    P += sell[i][g] == 0
            P += buy[i][g] + sell[i][g] <= 1

        n_tr = pulp.lpSum(buy[i][g] for i in ids)

        if wildcard_gw is not None and g == wildcard_gw:
            P += hits[g] == 0                       # wildcard: unlimited, free
        elif free_build and g == g0:
            P += hits[g] == 0
            # `ft` MUST be pinned here too. Leaving it free let the solver
            # choose ft[g0] = MAX_FREE_TRANSFERS for a fresh squad, and the
            # bank carried forward: it then took three transfers in GW2 and
            # three more in GW3 while reporting zero hits, which is not a legal
            # team. A squad built from scratch has banked nothing — it receives
            # its first free transfer the following gameweek, like everyone.
            P += ft[g] == 0
        else:
            if g == g0:
                P += ft[g] == min(free_transfers, MAX_FREE_TRANSFERS) if not free_build else ft[g] == 0
            else:
                pg = G[G.index(g) - 1]
                P += ft[g] <= ft[pg] + 1 - pulp.lpSum(buy[i][pg] for i in ids) + hits[pg]
            P += hits[g] >= n_tr - ft[g]

    if wildcard_gw is None:
        P += pulp.lpSum(hits[g] for g in G) <= max_hits_total
    else:
        P += pulp.lpSum(hits[g] for g in G if g != wildcard_gw) <= max_hits_total

    # --- user locks ---
    for i in (must_include or []):
        if i in ids:
            for g in G:
                P += own[i][g] == 1
    for i in (must_exclude or []):
        if i in ids:
            for g in G:
                P += own[i][g] == 0

    # --- no-good cuts for alternatives ---
    for prev in (forbid or []):
        prev = [i for i in prev if i in ids]
        if prev:
            P += pulp.lpSum(own[i][g0] for i in prev) <= SQUAD_SIZE - 1

    # --- objective ---
    obj = []
    for h, g in enumerate(G):
        d = discount ** h
        for i in ids:
            v = float(xp.at[i, g])
            is_gk = meta.at[i, "position"] == "GK"
            obj.append(d * v * start[i][g])
            obj.append(d * v * capt[i][g])
            if autosub:
                # The keeper's bench value is his own chance of playing times
                # the chance the first keeper does not; the outfield bench is
                # priced by the slot the solver puts him in.
                if is_gk:
                    obj.append(d * v * BENCH_GK_WEIGHT * (own[i][g] - start[i][g]))
                else:
                    for s in SLOTS:
                        obj.append(d * v * AUTOSUB_SLOT_P[s] * bench[i][g][s])
            else:
                bw = BENCH_GK_WEIGHT if is_gk else BENCH_WEIGHT
                obj.append(d * v * bw * (own[i][g] - start[i][g]))
            if chips:
                # BB week: bench scores in FULL. The top-up is measured from
                # whatever the bench was already credited — the mean autosub
                # slot value, or the flat weight when ordering is off — so the
                # chip is worth the same regardless of which mode is running.
                base_bw = (BENCH_GK_WEIGHT if is_gk
                           else (BENCH_WEIGHT if not autosub
                                 else sum(AUTOSUB_SLOT_P) / len(AUTOSUB_SLOT_P)))
                obj.append(d * v * (1.0 - base_bw) * z_bb[i][g])
                # TC week: captain scores 3x instead of 2x (one extra xp).
                obj.append(d * v * z_tc[i][g])
    P += pulp.lpSum(obj) - TRANSFER_HIT * pulp.lpSum(hits[g] for g in G)

    P.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=time_limit))
    status = pulp.LpStatus[P.status]

    if status not in ("Optimal",):
        # Never hand back a squad from an infeasible or unsolved model — that
        # is how these tools silently emit illegal teams. Diagnose instead.
        return {
            "status": status,
            "objective": float("-inf"),
            "weeks": [],
            "squad_ids": [],
            "total_hits": 0,
            "meta": meta,
            "xp_table": xp,
            "gated_out": gated,
            "diagnosis": _diagnose(status, current_squad, meta, must_include,
                                   must_exclude, budget, bank, max_hits_total,
                                   free_transfers, len(G)),
        }

    def on(v):
        return v.value() is not None and v.value() > 0.5

    weeks = []
    for g in G:
        sq = [i for i in ids if on(own[i][g])]
        xi = [i for i in sq if on(start[i][g])]
        cap = [i for i in sq if on(capt[i][g])]
        # Bench in autosub ORDER — slot 1 first — with the marginal value each
        # slot contributes, so the UI can show why a bench place is worth
        # paying for rather than just listing four leftovers.
        bench_order, autosub_ev = [], {}
        if autosub:
            for s in SLOTS:
                pick = [i for i in sq if on(bench[i][g][s])]
                if pick:
                    bench_order.append(pick[0])
                    autosub_ev[pick[0]] = round(
                        float(xp.at[pick[0], g]) * AUTOSUB_SLOT_P[s], 3)
        rest = [i for i in sq if i not in xi and i not in bench_order]
        for i in rest:
            if meta.at[i, "position"] == "GK":
                autosub_ev[i] = round(float(xp.at[i, g]) * BENCH_GK_WEIGHT, 3)
        weeks.append({
            "gw": g,
            "squad": sq,
            "xi": xi,
            "bench": bench_order + rest if autosub else [i for i in sq if i not in xi],
            "autosub_ev": autosub_ev,
            "captain": cap[0] if cap else None,
            "bench_boost": bool(chips and on(bb[g])),
            "triple_captain": bool(chips and on(tc[g])),
            "transfers_in": [i for i in ids if on(buy[i][g])],
            "transfers_out": [i for i in ids if on(sell[i][g])],
            "hits": int(round(hits[g].value() or 0)),
            "cost": round(sum(price[i] for i in sq), 1),
            "xp": round(float(sum(xp.at[i, g] for i in xi)
                              + (xp.at[cap[0], g] if cap else 0)), 2),
        })

    return {
        "status": status,
        "objective": float(pulp.value(P.objective) or 0.0),
        "weeks": weeks,
        "squad_ids": weeks[0]["squad"] if weeks else [],
        "total_hits": sum(w["hits"] for w in weeks),
        "meta": meta,
        "xp_table": xp,
        "gated_out": gated,
        "unavailable_out": unavailable,
    }


def _diagnose(status, current_squad, meta, must_include, must_exclude,
              budget, bank, max_hits_total, free_transfers, n_gws) -> str:
    """Explain WHY the model could not be solved, in plain English."""
    if status != "Infeasible":
        return f"Solver returned {status} — try raising time_limit."
    msgs = []
    if current_squad:
        pos = pd.Series([meta.at[i, "position"] for i in current_squad
                         if i in meta.index]).value_counts()
        for p, n in SQUAD_QUOTA.items():
            if pos.get(p, 0) != n:
                msgs.append(f"your current squad has {pos.get(p, 0)} {p} (needs {n}) — "
                            f"fixing that alone costs transfers")
        club = pd.Series([meta.at[i, "team"] for i in current_squad
                          if i in meta.index]).value_counts()
        if len(club) and club.max() > MAX_PER_CLUB:
            msgs.append(f"{club.idxmax()} appears {club.max()} times (max {MAX_PER_CLUB})")
        need = sum(1 for i in current_squad if i not in meta.index)
        if need:
            msgs.append(f"{need} of your players are not in the projection set "
                        f"(screened out by an ownership filter, or no longer registered)")
        cap = free_transfers + max_hits_total + (n_gws - 1)
        msgs.append(f"transfer budget allows about {cap} changes over {n_gws} GWs — "
                    f"raise max_hits_total if the required rebuild is larger")
    if must_include:
        cost = sum(float(meta.at[i, "price"]) for i in must_include if i in meta.index)
        if cost > budget + bank - 11 * 4.0:
            msgs.append(f"must_include costs £{cost:.1f}m, leaving too little for the rest")
        inc_pos = pd.Series([meta.at[i, "position"] for i in must_include
                             if i in meta.index]).value_counts()
        for p, n in SQUAD_QUOTA.items():
            if inc_pos.get(p, 0) > n:
                msgs.append(f"must_include has {inc_pos.get(p,0)} {p}, quota is {n}")
        inc_club = pd.Series([meta.at[i, "team"] for i in must_include
                              if i in meta.index]).value_counts()
        if len(inc_club) and inc_club.max() > MAX_PER_CLUB:
            msgs.append(f"must_include has {inc_club.max()} from {inc_club.idxmax()} "
                        f"(max {MAX_PER_CLUB})")
    if not msgs:
        msgs.append("no single cause identified — most likely the budget is too "
                    "low for a legal 15, or filters removed too many players")
    return "Infeasible: " + "; ".join(msgs)


def alternatives(proj: pd.DataFrame, gws: list[int], n: int = 4, **kw) -> list[dict]:
    """Near-optimal squads via no-good cuts, reported with xP gap and overlap."""
    out, forbid, base, first = [], list(kw.pop("forbid", []) or []), None, set()
    for _ in range(n + 1):
        r = solve(proj, gws, forbid=forbid, **kw)
        if r["status"] != "Optimal" or not r["squad_ids"]:
            break
        if base is None:
            base, first = r["objective"], set(r["squad_ids"])
        r["gap"] = round(r["objective"] - base, 2)
        r["overlap"] = len(set(r["squad_ids"]) & first)
        out.append(r)
        forbid.append(r["squad_ids"])
    return out
