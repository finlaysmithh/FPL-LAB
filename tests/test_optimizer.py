"""Optimiser tests. Uses a synthetic FIXTURE (test data only, never a product path)."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import pandas as pd, numpy as np
from fplab import optimize
from fplab.config import SQUAD_QUOTA, SQUAD_SIZE, MAX_PER_CLUB

def fake_proj(n_teams=20, per_team=8, gws=(1,2,3,4), seed=1):
    rng = np.random.default_rng(seed)
    rows, pid = [], 1
    pos_cycle = ["GK","GK","DEF","DEF","DEF","MID","MID","FWD"]
    for t in range(n_teams):
        for j in range(per_team):
            pos = pos_cycle[j % len(pos_cycle)]
            price = round(float(rng.uniform(4.0, 12.5)), 1)
            base = rng.uniform(0.5, 7.0)
            for g in gws:
                rows.append({"fpl_id": pid, "gw": g, "xp": max(0.0, base + rng.normal(0, .6)),
                             "display_name": f"P{pid}", "team": f"T{t:02d}", "position": pos,
                             "price": price, "provisional": False,
                             "ownership": float(rng.uniform(0, 60))})
            pid += 1
    return pd.DataFrame(rows)

def check_legal(res, proj):
    assert res["status"] == "Optimal", f"status={res['status']} {res.get('diagnosis','')}"
    meta = res["meta"]
    for w in res["weeks"]:
        assert len(w["squad"]) == SQUAD_SIZE, f"GW{w['gw']} squad {len(w['squad'])}"
        pc = pd.Series([meta.at[i,"position"] for i in w["squad"]]).value_counts()
        for p,n in SQUAD_QUOTA.items(): assert pc.get(p,0)==n, f"{p}={pc.get(p,0)}"
        tc = pd.Series([meta.at[i,"team"] for i in w["squad"]]).value_counts()
        assert tc.max() <= MAX_PER_CLUB, f"club cap {tc.max()}"
        assert len(w["xi"]) == 11
        assert w["cost"] <= 100.01, w["cost"]
        assert w["captain"] in w["xi"]

gws=[1,2,3,4]; proj = fake_proj(gws=gws)
print("players:", proj.fpl_id.nunique())

# 1 wildcard / free build
r = optimize.solve(proj, gws)
check_legal(r, proj); print(f"[1] free build      obj={r['objective']:.1f} cost={r['weeks'][0]['cost']} hits={r['total_hits']}")

# 2 continuity: no transfers allowed -> squad identical every week
assert all(set(w["squad"])==set(r["weeks"][0]["squad"]) for w in r["weeks"]), "squad drifted with no transfers"
print("[2] continuity      OK (squad constant across 4 GWs)")

# 3 weekly from an existing squad, 1 FT, no hits
# Build a LEGAL alternative starting squad: swap 3 players like-for-like by
# position and club-safe, so quotas hold. (v1 test swapped blindly and produced
# an illegal squad, which surfaced as a confusing "Infeasible".)
meta_all = proj.drop_duplicates("fpl_id").set_index("fpl_id")
cur = list(r["weeks"][0]["squad"])
strength = proj.groupby("fpl_id").xp.sum()
cur2 = list(cur)
for target in sorted(cur, key=lambda i: strength[i])[:3]:
    pos, = (meta_all.at[target,"position"],)
    clubs = pd.Series([meta_all.at[i,"team"] for i in cur2 if i != target]).value_counts()
    cands = [i for i in meta_all.index
             if i not in cur2 and meta_all.at[i,"position"]==pos
             and clubs.get(meta_all.at[i,"team"],0) < 3
             and sum(meta_all.at[j,"price"] for j in cur2 if j!=target)+meta_all.at[i,"price"] <= 100.0]
    if cands:
        pick = min(cands, key=lambda i: strength[i])
        cur2[cur2.index(target)] = pick
assert len(cur2)==15 and len(set(cur2))==15
r2 = optimize.solve(proj, [1], current_squad=cur2, free_transfers=1, max_hits_total=0)
assert r2["status"]=="Optimal", r2.get("diagnosis")
n_in = len(r2["weeks"][0]["transfers_in"])
assert n_in <= 1, n_in
print(f"[3] 1 FT no hits    transfers_in={n_in} (<=1) OK")

# 4 hits allowed -> should take more transfers and score higher
r3 = optimize.solve(proj, [1], current_squad=cur2, free_transfers=1, max_hits_total=2)
print(f"[4] 2 hits allowed  transfers_in={len(r3['weeks'][0]['transfers_in'])} hits={r3['total_hits']} obj {r2['objective']:.1f}->{r3['objective']:.1f}")
assert r3["objective"] >= r2["objective"] - 1e-6

# 5 multi-period transfer PLANNING (the v1 failure)
r4 = optimize.solve(proj, gws, current_squad=cur2, free_transfers=1, max_hits_total=1)
assert r4["status"]=="Optimal", r4.get("diagnosis")
assert r4["total_hits"] <= 1, f"hit cap violated: {r4['total_hits']}"
sched = [(w["gw"], len(w["transfers_in"]), w["hits"]) for w in r4["weeks"]]
check_legal(r4, proj)
print(f"[5] horizon plan    (gw,in,hits)={sched}  total_hits={r4['total_hits']}")
assert sum(x[1] for x in sched) >= 1, "made no transfers across 4 GWs"

# 6 must_include hard lock
lock = [int(proj.fpl_id.unique()[5]), int(proj.fpl_id.unique()[99])]
r5 = optimize.solve(proj, gws, must_include=lock)
assert all(all(i in w["squad"] for i in lock) for w in r5["weeks"])
print(f"[6] must_include    {lock} present in all GWs OK")

# 7 must_exclude
ban = r["weeks"][0]["squad"][:3]
r6 = optimize.solve(proj, gws, must_exclude=ban)
assert not any(i in w["squad"] for w in r6["weeks"] for i in ban)
print(f"[7] must_exclude    banned {len(ban)} absent OK")

# 8 ownership screen (differentials)
r7 = optimize.solve(proj, gws, max_ownership=15.0)
own = [r7["meta"].at[i,"ownership"] for i in r7["weeks"][0]["squad"]]
assert max(own) <= 15.01, max(own)
print(f"[8] differentials   max own {max(own):.1f}% <= 15 OK, obj {r['objective']:.1f}->{r7['objective']:.1f}")

# 9 alternatives distinct
alts = optimize.alternatives(proj, gws, n=3)
sigs = [tuple(sorted(a["squad_ids"])) for a in alts]
assert len(set(sigs)) == len(sigs), "duplicate alternative squads"
print(f"[9] alternatives    {len(alts)} distinct, gaps={[a['gap'] for a in alts]} overlaps={[a['overlap'] for a in alts]}")

# 10 wildcard gw is free
r8 = optimize.solve(proj, gws, current_squad=cur2, free_transfers=1, wildcard_gw=2, max_hits_total=0)
wc = [w for w in r8["weeks"] if w["gw"]==2][0]
print(f"[10] wildcard GW2   transfers_in={len(wc['transfers_in'])} hits={wc['hits']} OK")
assert wc["hits"] == 0

# 11 infeasible must be reported, never silently returned
bad = optimize.solve(proj, gws, budget=40.0)
assert bad["status"] != "Optimal" and bad["squad_ids"] == []
print(f"[11] infeasible     status={bad['status']}, no squad returned OK")
print(f"     diagnosis: {bad['diagnosis'][:110]}")

# 12 impossible must_include (4 from one club) is diagnosed
t0 = proj.iloc[0]["team"]
four = [int(i) for i in proj[proj.team==t0].fpl_id.unique()[:4]]
r9 = optimize.solve(proj, gws, must_include=four)
print(f"[12] club-cap clash status={r9['status']}")
if r9["status"]!="Optimal": print(f"     diagnosis: {r9['diagnosis'][:110]}")

# 13 minutes gate: sub-threshold players are excluded, must_include overrides
proj_m = proj.copy()
low = sorted(proj_m.fpl_id.unique())[:12]
proj_m["exp_mins"] = 70.0
proj_m.loc[proj_m.fpl_id.isin(low), "exp_mins"] = 12.0     # under the 25 gate
r10 = optimize.solve(proj_m, gws, min_expected_minutes=25.0)
check_legal(r10, proj_m)
assert not (set(r10["squad_ids"]) & set(low)), "gated player made the squad"
assert set(r10["gated_out"]) == set(low), f"gated_out={len(r10['gated_out'])} expected {len(low)}"
print(f"[13] minutes gate   {len(r10['gated_out'])} excluded, none selected OK")

forced = int(low[0])
r11 = optimize.solve(proj_m, gws, min_expected_minutes=25.0, must_include=[forced])
check_legal(r11, proj_m)
assert forced in r11["squad_ids"], "must_include did not override the gate"
assert forced not in r11["gated_out"]
print(f"[14] must_include   overrides gate for {forced}, squad still legal OK")

# 15 chips are at most one week each and never reduce the objective
r12 = optimize.solve(proj, gws, chips=True)
check_legal(r12, proj)
bb = [w["gw"] for w in r12["weeks"] if w["bench_boost"]]
tc = [w["gw"] for w in r12["weeks"] if w["triple_captain"]]
assert len(bb) <= 1 and len(tc) <= 1, f"BB={bb} TC={tc}"
base = optimize.solve(proj, gws, chips=False)
assert r12["objective"] >= base["objective"] - 1e-6
print(f"[15] chips          BB={bb} TC={tc}, obj {base['objective']:.1f}->{r12['objective']:.1f} OK")



# ---------------------------------------------------------------------------
# [16] ROTATION VALUE — the max-over-formations step must actually pay for
# complementary fixture runs.
#
# Priced at 20.0 so the budget admits exactly ONE pair — without that the
# squad simply buys all four and the test proves nothing.
# Two defenders whose good weeks ALTERNATE are worth more than two whose good
# weeks coincide, even when both pairs average identically, because only
# eleven players score and the XI is re-chosen every gameweek. If the
# optimiser is indifferent between them it is scoring the squad rather than
# the team, and rotation value is being thrown away.
def rotation_case():
    rows = []
    pid = 1
    gws = [1, 2, 3, 4]
    # Filler: enough legal bodies at a flat, mediocre rate.
    for t in range(20):
        for pos, n in (("GK", 2), ("DEF", 2), ("MID", 4), ("FWD", 2)):
            for _ in range(n):
                for g in gws:
                    rows.append({"fpl_id": pid, "gw": g, "xp": 1.0,
                                 "display_name": f"F{pid}", "team": f"T{t:02d}",
                                 "position": pos, "price": 4.0,
                                 "provisional": False, "ownership": 1.0,
                                 "exp_mins": 90, "status": "a"})
                pid += 1
    # ALTERNATING pair: one peaks on odd gameweeks, the other on even.
    alt = []
    for k, pattern in enumerate(([6.0, 1.0, 6.0, 1.0], [1.0, 6.0, 1.0, 6.0])):
        for g, v in zip(gws, pattern):
            rows.append({"fpl_id": pid, "gw": g, "xp": v, "display_name": f"ALT{k}",
                         "team": f"A{k}", "position": "DEF", "price": 20.0,
                         "provisional": False, "ownership": 1.0,
                         "exp_mins": 90, "status": "a"})
        alt.append(pid); pid += 1
    # COINCIDING pair: identical runs, same mean (3.5), same price.
    same = []
    for k in range(2):
        for g, v in zip(gws, [6.0, 1.0, 6.0, 1.0]):
            rows.append({"fpl_id": pid, "gw": g, "xp": v, "display_name": f"SAME{k}",
                         "team": f"S{k}", "position": "DEF", "price": 20.0,
                         "provisional": False, "ownership": 1.0,
                         "exp_mins": 90, "status": "a"})
        same.append(pid); pid += 1
    return pd.DataFrame(rows), alt, same, gws


proj16, alt_ids, same_ids, gws16 = rotation_case()
r16 = optimize.solve(proj16, gws16, allow_transfers=False, time_limit=60)
assert r16["status"] == "Optimal", r16.get("diagnosis")
picked = set(r16["squad_ids"])
n_alt = len(picked & set(alt_ids))
n_same = len(picked & set(same_ids))
assert n_alt == 2, f"alternating pair not both selected: {n_alt}/2"
assert n_alt > n_same, (
    f"optimiser is indifferent to rotation: took {n_alt} alternating vs "
    f"{n_same} coinciding — the per-gameweek XI choice is not firing")
# And the XI must actually change between gameweeks.
xis = {tuple(sorted(w["xi"])) for w in r16["weeks"]}
assert len(xis) > 1, "same XI every gameweek — max-over-formations not firing"
print(f"[16] rotation      alt {n_alt}/2 vs same {n_same}/2, "
      f"{len(xis)} distinct XIs across {len(gws16)} GWs OK")



# ---------------------------------------------------------------------------
# [17] SELLING PRICE — FPL pays purchase price plus HALF the rise, rounded
# down; a fall is taken in full. Every transfer suggestion depends on the
# budget this produces, so it is asserted directly rather than trusted.
for bought, now, expect in [(5.0, 5.3, 5.1), (5.0, 5.4, 5.2), (5.0, 5.5, 5.2),
                            (5.0, 4.7, 4.7), (5.0, 5.0, 5.0), (4.5, 5.1, 4.8),
                            (10.0, 11.3, 10.6), (6.5, 6.6, 6.5)]:
    got = optimize.selling_price(bought, now)
    assert abs(got - expect) < 1e-9, f"sell({bought},{now})={got} expected {expect}"
print("[17] selling price  8 cases exact OK")

# A risen player must free LESS than his listed price, and the optimiser must
# respect that when it plans a transfer out.
sq = list(r["weeks"][0]["squad"])
risen = {i: meta_all.at[i, "price"] - 0.4 for i in sq}      # each rose 0.4
r13 = optimize.solve(proj, [1], current_squad=sq, free_transfers=1,
                     max_hits_total=0, purchase_prices=risen)
assert r13["status"] == "Optimal", r13.get("diagnosis")
assert r13["weeks"][0]["cost"] <= 100.01
print(f"[18] sell price MILP solves with purchase prices, cost "
      f"{r13['weeks'][0]['cost']} OK")

print("\nALL TESTS PASSED")
