"""Generate sample data.json / optimal.json for UI development.

Same schema as export_data.py, so `python webapp/export_data.py` (run after
the real pipeline) overwrites these with real projections. No dependencies.
"""
import json, random
from pathlib import Path

random.seed(27)
OUT = Path(__file__).resolve().parent
GWS = list(range(1, 7))
TEAMS = ["ARS","AVL","BOU","BRE","BHA","CHE","COV","CRY","EVE","FUL",
         "HUL","IPS","LEE","LIV","MCI","MUN","NEW","NFO","SUN","TOT"]
PROMOTED = ["COV", "HUL", "IPS"]

# Team strength 1 (weak) .. 10 (elite): drives FDR and projection noise.
STRENGTH = {"ARS":9.4,"MCI":9.2,"LIV":9.3,"CHE":8.3,"TOT":7.6,"NEW":7.8,
            "AVL":7.4,"MUN":7.2,"BHA":6.8,"CRY":6.6,"BOU":6.4,"BRE":6.2,
            "FUL":6.0,"NFO":6.1,"EVE":5.8,"LEE":5.2,"SUN":5.0,
            "COV":4.4,"HUL":4.2,"IPS":4.3}

# (name, pos, price, ownership%, pen_taker) per club — 2026/27 flavour.
ROSTERS = {
 "ARS": [("Raya","GK",5.6,18),("Saliba","DEF",6.1,22),("Gabriel","DEF",6.3,28),
         ("Timber","DEF",5.9,14),("Calafiori","DEF",5.7,9),("Ødegaard","MID",8.2,12),
         ("Saka","MID",10.1,32),("Rice","MID",6.6,10),("Eze","MID",7.6,11),
         ("Gyökeres","FWD",9.4,34,1),("Havertz","FWD",7.3,6)],
 "AVL": [("Martínez","GK",5.0,9),("Konsa","DEF",4.6,6),("Pau Torres","DEF",4.7,7),
         ("Cash","DEF",4.5,5),("Rogers","MID",7.1,15),("McGinn","MID",5.6,4),
         ("Tielemans","MID",5.5,5),("Watkins","FWD",8.8,21,1),("Malen","FWD",5.9,3)],
 "BOU": [("Petrović","GK",4.6,7),("Truffert","DEF",4.6,5),("Senesi","DEF",4.8,9),
         ("Smith","DEF",4.4,4),("Semenyo","MID",7.7,24,1),("Brooks","MID",5.3,4),
         ("Tavernier","MID",5.4,4),("Evanilson","FWD",7.0,8),("Kroupi","FWD",5.6,4)],
 "BRE": [("Kelleher","GK",4.7,10),("Collins","DEF",4.9,7),("Van den Berg","DEF",4.5,5),
         ("Ajer","DEF",4.4,3),("Mbeumo? No—","MID",0,0)],
 "BHA": [("Verbruggen","GK",4.7,8),("Van Hecke","DEF",4.6,6),("Dunk","DEF",4.4,3),
         ("Estupiñán","DEF",4.7,5),("Mitoma","MID",6.6,9),("Minteh","MID",6.2,8),
         ("Baleba","MID",5.1,3),("Welbeck","FWD",6.3,7,1),("Pedro","FWD",7.4,10)],
 "CHE": [("Sánchez","GK",5.0,11),("Colwill","DEF",5.1,7),("Cucurella","DEF",6.1,16),
         ("James","DEF",5.6,8),("Gusto","DEF",4.8,4),("Palmer","MID",10.6,38,1),
         ("Fernández","MID",6.4,7),("Neto","MID",7.0,9),("João Pedro","FWD",7.8,17),
         ("Delap","FWD",6.6,9)],
 "COV": [("Wilson","GK",4.0,6),("Kitching","DEF",4.0,5),("Thomas","DEF",4.0,4),
         ("Latibeaudiere","DEF",4.0,3),("O'Hare","MID",5.4,5,1),("Eccles","MID",4.6,2),
         ("Sakamoto","MID",5.6,6),("Simms","FWD",5.6,5),("Wright","FWD",4.6,2)],
 "CRY": [("Henderson","GK",4.8,9),("Guéhi","DEF",4.9,10),("Richards","DEF",4.5,4),
         ("Mitchell","DEF",4.8,5),("Eze gone—Kamada","MID",5.2,3),("Sarr","MID",6.4,9),
         ("Hughes","MID",5.0,2),("Mateta","FWD",7.6,16,1),("Nketiah","FWD",5.6,4)],
 "EVE": [("Pickford","GK",5.1,13),("Tarkowski","DEF",4.9,8),("Branthwaite","DEF",5.0,7),
         ("Mykolenko","DEF",4.4,3),("Ndiaye","MID",6.3,8,1),("Grealish","MID",6.8,12),
         ("Garner","MID",5.0,3),("Beto","FWD",5.9,6),("Barry","FWD",5.4,4)],
 "FUL": [("Leno","GK",5.0,9),("Castagne","DEF",4.5,4),("Bassey","DEF",4.6,5),
         ("Robinson","DEF",4.9,8),("Iwobi","MID",5.7,6),("Smith Rowe","MID",5.5,4),
         ("Wilson","MID",6.0,6,1),("Muniz","FWD",6.4,8),("Jiménez","FWD",6.5,7)],
 "HUL": [("Pandur","GK",4.0,5),("Coyle","DEF",4.0,4),("Jones","DEF",4.0,3),
         ("Giles","DEF",4.2,4),("Millar","MID",5.0,4),("Slater","MID",4.6,2),
         ("Gelhardt","FWD",5.2,4,1),("Joseph","FWD",4.8,3)],
 "IPS": [("Walton","GK",4.2,6),("Davis","DEF",4.0,4),("Woolfenden","DEF",4.0,3),
         ("Greaves","DEF",4.2,5),("Hutchinson","MID",5.5,6),("Chaplin","MID",5.2,4),
         ("Delacourt","MID",4.8,2),("Hirst","FWD",5.6,5,1),("Philogene","FWD",5.5,4)],
 "LEE": [("Meslier","GK",4.4,7),("Struijk","DEF",4.4,5),("Rodon","DEF",4.2,4),
         ("Firpo","DEF",4.6,6),("James","MID",5.9,7,1),("Aaronson","MID",5.2,3),
         ("Stach","MID",5.0,3),("Nmecha","FWD",5.9,7),("Piroe","FWD",5.4,3)],
 "LIV": [("Alisson","GK",5.6,15),("Van Dijk","DEF",6.0,18),("Konaté","DEF",5.4,8),
         ("Kerkez","DEF",5.9,12),("Frimpong","DEF",5.8,10),("Salah","MID",14.3,52,1),
         ("Wirtz","MID",9.6,26),("Szoboszlai","MID",6.6,8),("Gakpo","MID",7.6,12),
         ("Isak","FWD",10.6,30),("Ekitiké","FWD",8.6,19)],
 "MCI": [("Donnarumma","GK",5.7,17),("Dias","DEF",5.5,7),("Gvardiol","DEF",6.0,13),
         ("Aït-Nouri","DEF",5.8,9),("Stones","DEF",5.2,4),("Foden","MID",8.9,14),
         ("Bernardo","MID",6.4,6),("Cherki","MID",7.1,10),("Doku","MID",7.2,11),
         ("Haaland","FWD",14.1,56,1),("Marmoush","FWD",8.3,14)],
 "MUN": [("Lammens","GK",4.7,8),("De Ligt","DEF",5.1,7),("Yoro","DEF",4.9,5),
         ("Dalot","DEF",4.8,4),("Dorgu","DEF",4.6,4),("Fernandes","MID",9.0,18,1),
         ("Mbeumo","MID",8.4,22),("Amad","MID",6.7,9),("Cunha","FWD",8.1,15),
         ("Šeško","FWD",7.4,11)],
 "NEW": [("Pope","GK",5.1,10),("Trippier","DEF",5.3,8),("Burn","DEF",4.7,6),
         ("Hall","DEF",5.4,9),("Livramento","DEF",4.9,5),("Gordon","MID",7.6,14,1),
         ("Tonali","MID",6.1,6),("Bruno G.","MID",6.4,7),("Barnes","MID",6.5,8),
         ("Woltemade","FWD",7.3,12),("Wissa","FWD",7.4,10)],
 "NFO": [("Sels","GK",5.0,12),("Milenković","DEF",5.0,8),("Murillo","DEF",5.3,9),
         ("Aina","DEF",5.1,7),("Williams","DEF",4.6,3),("Gibbs-White","MID",7.4,12,1),
         ("Anderson","MID",5.4,4),("Ndoye","MID",6.1,6),("Hudson-Odoi","MID",6.0,5),
         ("Wood","FWD",7.2,13),("Igor Jesus","FWD",6.2,6)],
 "SUN": [("Roefs","GK",4.4,6),("Ballard","DEF",4.4,5),("O'Nien","DEF",4.2,3),
         ("Hume","DEF",4.5,5),("Le Fée","MID",5.3,4,1),("Sadiki","MID",4.8,2),
         ("Talbi","MID",5.6,6),("Isidor","FWD",5.7,6),("Mayenda","FWD",5.3,4)],
 "TOT": [("Vicario","GK",5.0,11),("Van de Ven","DEF",5.3,9),("Romero","DEF",5.2,7),
         ("Porro","DEF",5.6,10),("Udogie","DEF",4.8,4),("Kudus","MID",7.3,11),
         ("Sarr","MID",5.4,4),("Bergvall","MID",5.7,5),("Simons","MID",7.5,12),
         ("Solanke","FWD",7.4,10,1),("Richarlison","FWD",6.8,8)],
}
# Fix two authoring slips above: Brentford roster + Palace mid.
ROSTERS["BRE"] = [("Kelleher","GK",4.7,10),("Collins","DEF",4.9,7),
    ("Van den Berg","DEF",4.5,5),("Ajer","DEF",4.4,3),("Damsgaard","MID",6.0,7),
    ("Janelt","MID",5.0,3),("Schade","MID",6.3,8),("Thiago","FWD",6.9,12,1),
    ("Ouattara","FWD",5.8,5)]
ROSTERS["CRY"] = [("Henderson","GK",4.8,9),("Guéhi","DEF",4.9,10),
    ("Richards","DEF",4.5,4),("Mitchell","DEF",4.8,5),("Kamada","MID",5.2,3),
    ("Sarr","MID",6.4,9),("Hughes","MID",5.0,2),("Mateta","FWD",7.6,16,1),
    ("Nketiah","FWD",5.6,4)]

# ---- fixtures: 6 GWs of symmetric pairings --------------------------------
def make_fixtures():
    fixtures = {t: {"a": [], "o": []} for t in TEAMS}
    for gw in GWS:
        teams = TEAMS[:]
        random.shuffle(teams)
        pairs = [(teams[k], teams[k+1]) for k in range(0, 20, 2)]
        for home, away in pairs:
            # attack FDR: how hard to score vs that opponent (2..9)
            def fdr(opp, at_home):
                v = 1.2 + STRENGTH[opp] * 0.72 + (0 if at_home else 0.9)
                return round(max(2.0, min(9.0, v + random.uniform(-0.4, 0.4))), 1)
            fixtures[home]["a"].append(fdr(away, True))
            fixtures[home]["o"].append(away)          # home: uppercase
            fixtures[away]["a"].append(fdr(home, False))
            fixtures[away]["o"].append(home.lower())  # away: lowercase
    return fixtures

FDR = make_fixtures()

# ---- players ---------------------------------------------------------------
players, pid = [], 100
for t in TEAMS:
    for row in ROSTERS[t]:
        name, pos, price, own = row[0], row[1], row[2], row[3]
        pk = 1 if len(row) > 4 else 0
        if price == 0:
            continue
        base = price * (0.52 if pos in ("MID", "FWD") else 0.46)
        base *= 0.9 + STRENGTH[t] / 45
        g = []
        for k in range(6):
            hard = FDR[t]["a"][k]           # 2 easy .. 9 brutal
            mult = 1.45 - hard * 0.082
            g.append(round(max(0.4, base * mult * random.uniform(0.88, 1.12)), 2))
        players.append({"i": pid, "n": name, "t": t, "p": pos,
                        "c": round(price, 1), "o": round(own, 1),
                        "x": round(sum(g), 2), "g": g, "pk": pk})
        pid += 1
players.sort(key=lambda r: -r["x"])

# ---- greedy + swap-improvement squad solver -------------------------------
QUOTA = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
XI_MIN = {"GK": 1, "DEF": 3, "MID": 2, "FWD": 1}
XI_MAX = {"GK": 1, "DEF": 5, "MID": 5, "FWD": 3}
BUDGET = 100.0
by_id = {p["i"]: p for p in players}

def score(ids, ks):
    tot = 0.0
    for k in ks:
        pool = sorted((by_id[i] for i in ids), key=lambda p: -p["g"][k])
        xi, cnt = [], {"GK": 0, "DEF": 0, "MID": 0, "FWD": 0}
        for pos in QUOTA:
            for p in [q for q in pool if q["p"] == pos][:XI_MIN[pos]]:
                xi.append(p); cnt[pos] += 1
        for p in pool:
            if len(xi) >= 11: break
            if p in xi or cnt[p["p"]] >= XI_MAX[p["p"]]: continue
            xi.append(p); cnt[p["p"]] += 1
        tot += sum(p["g"][k] for p in xi) + max(p["g"][k] for p in xi)
    return tot

def cheap_base():
    ids, cc = [], {}
    for pos, q in QUOTA.items():
        n = 0
        for p in sorted((x for x in players if x["p"] == pos), key=lambda x: x["c"]):
            if n >= q: break
            if cc.get(p["t"], 0) >= 3: continue
            ids.append(p["i"]); cc[p["t"]] = cc.get(p["t"], 0) + 1; n += 1
    return ids

def climb(ids, ks):
    # Hill climb: apply the single best same-position swap until none improves.
    while True:
        base = score(ids, ks)
        best_gain, best_move = 0.02, None
        for out in ids:
            o = by_id[out]
            rest = [i for i in ids if i != out]
            left = BUDGET - sum(by_id[i]["c"] for i in rest)
            cc2 = {}
            for i in rest: cc2[by_id[i]["t"]] = cc2.get(by_id[i]["t"], 0) + 1
            for c in players:
                if c["p"] != o["p"] or c["i"] in rest or c["c"] > left + 1e-6: continue
                if cc2.get(c["t"], 0) >= 3: continue
                gain = score(rest + [c["i"]], ks) - base
                if gain > best_gain:
                    best_gain, best_move = gain, (out, c["i"])
        if not best_move:
            return ids
        ids = [i for i in ids if i != best_move[0]] + [best_move[1]]

def solve(ks, restarts=10):
    best = climb(cheap_base(), ks)
    best_s = score(best, ks)
    for _ in range(restarts):
        # kick: downgrade three random players to cheapest legal, re-climb
        ids = best[:]
        for out in random.sample(ids, 3):
            o = by_id[out]
            rest = [i for i in ids if i != out]
            cc2 = {}
            for i in rest: cc2[by_id[i]["t"]] = cc2.get(by_id[i]["t"], 0) + 1
            cands = sorted((c for c in players if c["p"] == o["p"]
                            and c["i"] not in rest and cc2.get(c["t"], 0) < 3),
                           key=lambda c: c["c"])
            if cands:
                ids = rest + [cands[0]["i"]]
        ids = climb(ids, ks)
        s = score(ids, ks)
        if s > best_s:
            best, best_s = ids, s
    return best

optimal = {}
for k in range(6):
    ids = solve([k])
    optimal[str(GWS[k])] = {"squad": ids, "xp": round(score(ids, [k]), 1),
                            "cost": round(sum(by_id[i]["c"] for i in ids), 1)}
ids = solve([0, 1, 2])
optimal["h3"] = {"squad": ids, "xp": round(score(ids, [0, 1, 2]), 1),
                 "cost": round(sum(by_id[i]["c"] for i in ids), 1)}
ids = solve(list(range(6)))
optimal["range"] = {"squad": ids, "xp": round(score(ids, list(range(6))), 1),
                    "cost": round(sum(by_id[i]["c"] for i in ids), 1)}

data = {"gws": GWS, "players": players, "fdr": FDR, "promoted": PROMOTED}
(OUT / "data.json").write_text(json.dumps(data))
(OUT / "optimal.json").write_text(json.dumps(optimal))
print(f"{len(players)} players, optimal range xp {optimal['range']['xp']}")
