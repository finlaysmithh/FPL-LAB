"""Transfer planner: the suggestions must be legal, funded and explained."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import numpy as np, pandas as pd
from fplab import planner, optimize
from fplab.config import MAX_PER_CLUB, TRANSFER_HIT

rng = np.random.default_rng(3)
rows, pid = [], 1
pos_cycle = ["GK", "GK", "DEF", "DEF", "DEF", "MID", "MID", "FWD"]
for t in range(20):
    for j in range(8):
        pos = pos_cycle[j % 8]
        price = round(float(rng.uniform(4.0, 12.0)), 1)
        base = rng.uniform(0.5, 7.0)
        for g in (1, 2, 3, 4, 5):
            rows.append({"fpl_id": pid, "gw": g, "xp": max(0.0, base + rng.normal(0, .5)),
                         "display_name": f"P{pid}", "team": f"T{t:02d}", "position": pos,
                         "price": price, "p_start_gw": float(rng.uniform(0.4, 1.0)),
                         "fdr_attack": float(rng.uniform(2, 8))})
        pid += 1
proj = pd.DataFrame(rows)
meta = proj.drop_duplicates("fpl_id").set_index("fpl_id")

# A legal starting squad.
squad, clubs, spend = [], {}, 0.0
need = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
for i in meta.sort_values("price").index:
    p = meta.loc[i]
    if need.get(p["position"], 0) <= 0 or clubs.get(p["team"], 0) >= 3:
        continue
    squad.append(int(i)); need[p["position"]] -= 1
    clubs[p["team"]] = clubs.get(p["team"], 0) + 1
    spend += p["price"]
    if len(squad) == 15: break
assert len(squad) == 15

res = planner.plan_transfers(proj, squad, [1, 2, 3, 4, 5], bank=6.0)
assert res["moves"], "planner produced no moves on a deliberately weak squad"
print(f"[1] produced {len(res['moves'])} ranked moves OK")

for m in res["moves"]:
    # Legal: same position, affordable from bank + sale, club cap respected.
    assert meta.at[m["out"], "position"] == meta.at[m["in_id"], "position"], m
    assert m["in_price"] <= 6.0 + m["sell_price"] + 1e-9, f"unfunded: {m}"
    assert m["in_id"] not in squad, "suggested a player already owned"
    after = [i for i in squad if i != m["out"]] + [m["in_id"]]
    tc = pd.Series([meta.at[i, "team"] for i in after]).value_counts()
    assert tc.max() <= MAX_PER_CLUB, f"club cap broken by {m}"
print("[2] every move legal, funded and within the club cap OK")

# Ranked by gain, and the hit arithmetic is right.
gains = [m["gain"] for m in res["moves"]]
assert gains == sorted(gains, reverse=True), "moves not ranked by gain"
for m in res["moves"]:
    assert abs(m["gain_after_hit"] - (m["gain"] - TRANSFER_HIT)) < 1e-6
    assert m["hit_pays"] == (m["gain_after_hit"] > 0)
print("[3] ranked by gain, hit arithmetic exact OK")

# Every move carries its reason.
for m in res["moves"]:
    assert m["peak_gw"] in (1, 2, 3, 4, 5)
    assert m["break_even_gw"] is None or m["break_even_gw"] in (1, 2, 3, 4, 5)
    assert "bench_risk" in m and "fdr_out" in m and "fdr_in" in m
print("[4] each move states peak GW, break-even and fixture swing OK")

# Bench risk fires on a genuinely rotation-risk signing.
risky = [m for m in res["moves"] if m["in_p_start"] is not None and m["in_p_start"] < 0.70]
assert all(m["bench_risk"] for m in risky), "bench risk not flagged below P(start) 0.70"
print(f"[5] bench-risk flag correct on {len(risky)} sub-0.70 signings OK")

# Roll-or-use always answers.
ro = planner.roll_or_use(res)
assert ro["verdict"] in ("roll", "use") and ro["why"]
print(f"[6] roll-or-use returns {ro['verdict'].upper()} with a reason OK")

print("\nALL PLANNER TESTS PASSED")
