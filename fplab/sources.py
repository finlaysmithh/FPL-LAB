"""
Real data sources. No synthetic fallbacks anywhere in this module.

Everything here hits a live endpoint and caches to disk. If a fetch fails, it
raises — it does not quietly substitute made-up numbers.

Endpoints
---------
FPL bootstrap-static/     every registered PL player, price, position, club,
                          injury status, season-to-date totals
FPL fixtures/             full fixture list, finished flags, actual scores
FPL element-summary/{id}/ per-GW history for this season + `history_past`
                          (previous seasons, including at a former club)
FPL entry/{id}/event/{gw}/picks/   your actual squad
Understat league/EPL/{yr} team and player xG/xA, as JSON in a <script> tag

Field-name robustness
---------------------
FPL renames fields between seasons (`defensive_contribution` did not exist
before 2025/26 and its key has changed once already). Rather than hardcode,
every extraction goes through `_first_key`, which tries a list of candidates
and records misses in the returned schema report. Run `fplab fetch --audit`
to see exactly which fields resolved and which did not, before trusting any
projection.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from pathlib import Path

import pandas as pd
import requests

FPL = "https://fantasy.premierleague.com/api"
UNDERSTAT = "https://understat.com/league/EPL/{year}"
UNDERSTAT_PLAYER = "https://understat.com/player/{pid}"
VAASTAV = ("https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/"
           "master/data/{season}/gws/merged_gw.csv")

DATA = Path(__file__).resolve().parent.parent / "data"
CACHE = DATA / "cache"
CACHE.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
}

POS_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}

# Candidate field names, most recent first. Extend when FPL renames something.
FIELD_CANDIDATES = {
    "xg": ["expected_goals"],
    "xa": ["expected_assists"],
    "xgi": ["expected_goal_involvements"],
    "xgc": ["expected_goals_conceded"],
    "defcon": ["defensive_contribution", "defensive_contributions",
               "clearances_blocks_interceptions_tackles", "defcon"],
    "cbi": ["clearances_blocks_interceptions"],
    "tackles": ["tackles"],
    "recoveries": ["recoveries", "ball_recoveries"],
    "starts": ["starts"],
}

SCHEMA_REPORT: dict[str, str | None] = {}


def _first_key(d: dict, logical: str, default=0.0):
    """Resolve a logical field to whichever concrete key the API is using."""
    for key in FIELD_CANDIDATES.get(logical, [logical]):
        if key in d and d[key] is not None:
            SCHEMA_REPORT[logical] = key
            try:
                return float(d[key])
            except (TypeError, ValueError):
                return d[key]
    SCHEMA_REPORT.setdefault(logical, None)
    return default


def _get(url: str, tries: int = 3, backoff: float = 1.5):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(backoff ** i)
    raise RuntimeError(f"Failed to fetch {url} after {tries} tries — {last}")


def _cached_json(name: str, url: str, max_age_h: float = 6.0, force: bool = False):
    p = CACHE / name
    if p.exists() and not force:
        age_h = (time.time() - p.stat().st_mtime) / 3600
        if age_h < max_age_h:
            return json.loads(p.read_text())
    data = _get(url).json()
    p.write_text(json.dumps(data))
    return data


# ---------------------------------------------------------------------------
# FPL
# ---------------------------------------------------------------------------
def bootstrap(force: bool = False) -> dict:
    return _cached_json("bootstrap.json", f"{FPL}/bootstrap-static/", 3.0, force)


def fixtures_raw(force: bool = False) -> list:
    return _cached_json("fixtures.json", f"{FPL}/fixtures/", 3.0, force)


def element_summary(pid: int, max_age_h: float = 24.0) -> dict:
    return _cached_json(f"element_{pid}.json", f"{FPL}/element-summary/{pid}/", max_age_h)


def entry_picks(entry_id: int, gw: int) -> dict:
    """Your actual squad for a given gameweek."""
    return _cached_json(f"entry_{entry_id}_{gw}.json",
                        f"{FPL}/entry/{entry_id}/event/{gw}/picks/", 1.0)


def entry_info(entry_id: int) -> dict:
    return _cached_json(f"entry_{entry_id}.json", f"{FPL}/entry/{entry_id}/", 1.0)


def current_gw(bs: dict) -> int:
    for e in bs["events"]:
        if e.get("is_current"):
            return e["id"]
    for e in bs["events"]:
        if e.get("is_next"):
            return e["id"]
    return 1


def all_players(bs: dict) -> pd.DataFrame:
    """
    Every registered Premier League player. This is the authoritative squad
    registry — Rogers appears under Chelsea the moment FPL lists him, with his
    new price. Season-to-date rates are normalised by minutes actually
    AVAILABLE, not by a full 38-game season.
    """
    teams = {t["id"]: t["short_name"] for t in bs["teams"]}
    team_full = {t["id"]: t["name"] for t in bs["teams"]}
    finished_gws = sum(1 for e in bs["events"] if e.get("finished"))
    avail_mins = max(finished_gws, 1) * 90

    rows = []
    for e in bs["elements"]:
        mins = int(e.get("minutes", 0) or 0)
        n90 = mins / 90.0
        d = max(n90, 0.5)  # avoid dividing tiny samples into huge rates
        rows.append({
            "fpl_id": e["id"],
            "web_name": e["web_name"],
            "full_name": f"{e['first_name']} {e['second_name']}".strip(),
            "team": teams[e["team"]],
            "team_full": team_full[e["team"]],
            "position": POS_MAP[e["element_type"]],
            "price": e["now_cost"] / 10.0,
            "ownership": float(e.get("selected_by_percent") or 0),
            "status": e.get("status", "a"),
            "chance_playing": e.get("chance_of_playing_next_round"),
            "news": e.get("news", ""),
            "minutes": mins,
            "starts": _first_key(e, "starts", 0),
            "n90_now": n90,
            "mins_share_now": min(mins / avail_mins, 1.0) if avail_mins else 0.0,
            "xg90_now": _first_key(e, "xg") / d,
            "xa90_now": _first_key(e, "xa") / d,
            "defcon90_now": _first_key(e, "defcon") / d,
            "bps90_now": float(e.get("bps", 0) or 0) / d,
            "saves90": float(e.get("saves", 0) or 0) / d,
            "yellow90": float(e.get("yellow_cards", 0) or 0) / d,
            "pens_order": e.get("penalties_order"),
            "corners_order": e.get("corners_and_indirect_freekicks_order"),
            "fk_order": e.get("direct_freekicks_order"),
            "total_points": e.get("total_points", 0),
            "form": float(e.get("form") or 0),
        })
    df = pd.DataFrame(rows)
    df["finished_gws"] = finished_gws
    return df


def previous_season_rates(pids: list[int], progress=None) -> pd.DataFrame:
    """
    Pull `history_past` for each player — their totals at whatever club they
    were at. This is what carries Rogers' Villa production into his Chelsea
    projection before he has kicked a ball for Chelsea.

    ~700 requests. Cached for 24h, so it's slow once and instant after.
    """
    rows = []
    for n, pid in enumerate(pids):
        try:
            s = element_summary(pid)
        except RuntimeError:
            continue
        past = s.get("history_past") or []
        if past:
            last = past[-1]
            mins = float(last.get("minutes", 0) or 0)
            d = max(mins / 90.0, 0.5)
            rows.append({
                "fpl_id": pid,
                "prior_season": last.get("season_name"),
                "prior_minutes": mins,
                "xg90_prior": _first_key(last, "xg") / d,
                "xa90_prior": _first_key(last, "xa") / d,
                "defcon90_prior": _first_key(last, "defcon") / d,
                "bps90_prior": float(last.get("bps", 0) or 0) / d,
                "prior_points": last.get("total_points", 0),
                "mins_share_prior": min(mins / (38 * 90), 1.0),
            })
        if progress and n % 50 == 0:
            progress(n, len(pids))
    return pd.DataFrame(rows)


def fixtures_frame(raw: list, bs: dict) -> pd.DataFrame:
    teams = {t["id"]: t["short_name"] for t in bs["teams"]}
    rows = []
    for f in raw:
        if not f.get("event"):
            continue
        rows.append({
            "gw": f["event"],
            "home": teams[f["team_h"]],
            "away": teams[f["team_a"]],
            "kickoff": f.get("kickoff_time"),
            "finished": bool(f.get("finished")),
            "home_goals": f.get("team_h_score"),
            "away_goals": f.get("team_a_score"),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Understat
# ---------------------------------------------------------------------------
def understat_league(year: int, force: bool = False) -> dict:
    """
    Understat embeds data as JSON.parse('...') with hex escapes. Returns
    {'teamsData': ..., 'playersData': ...}.
    """
    p = CACHE / f"understat_{year}.json"
    if p.exists() and not force:
        return json.loads(p.read_text())
    html = _get(UNDERSTAT.format(year=year)).text
    out = {}
    for key in ("teamsData", "playersData", "datesData"):
        m = re.search(key + r"\s*=\s*JSON\.parse\('([^']+)'\)", html)
        if m:
            out[key] = json.loads(m.group(1).encode().decode("unicode_escape"))
    if not out:
        raise RuntimeError(f"Understat {year}: no embedded JSON found — page layout changed")
    p.write_text(json.dumps(out))
    return out


def understat_team_match_log(year: int) -> pd.DataFrame:
    """
    The real per-match team xG log that drives the fixture model. This replaces
    the synthetic generator entirely.
    """
    data = understat_league(year)
    rows = []
    for _, t in data["teamsData"].items():
        name = t["title"]
        for h in t["history"]:
            rows.append({
                "team_understat": name,
                "was_home": h["h_a"] == "h",
                "xg_for": float(h["xG"]),
                "xg_against": float(h["xGA"]),
                "goals_for": h["scored"],
                "goals_against": h["missed"],
                "kickoff": h.get("date", ""),
            })
    df = pd.DataFrame(rows)
    return df.sort_values("kickoff").reset_index(drop=True)


def understat_players(year: int) -> pd.DataFrame:
    data = understat_league(year)
    rows = []
    for p in data["playersData"]:
        mins = float(p.get("time", 0) or 0)
        d = max(mins / 90.0, 0.5)
        rows.append({
            "understat_id": p["id"],
            "understat_name": p["player_name"],
            "understat_team": p.get("team_title", ""),
            "minutes": mins,
            "xg": float(p.get("xG", 0) or 0),
            "xa": float(p.get("xA", 0) or 0),
            "npxg": float(p.get("npxG", 0) or 0),
            "shots": float(p.get("shots", 0) or 0),
            "key_passes": float(p.get("key_passes", 0) or 0),
            "u_xg90": float(p.get("xG", 0) or 0) / d,
            "u_xa90": float(p.get("xA", 0) or 0) / d,
            "u_npxg90": float(p.get("npxG", 0) or 0) / d,
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Name matching — the part I skipped last time
# ---------------------------------------------------------------------------
TEAM_ALIASES = {
    "Manchester City": "MCI", "Manchester United": "MUN", "Liverpool": "LIV",
    "Arsenal": "ARS", "Chelsea": "CHE", "Tottenham": "TOT", "Newcastle United": "NEW",
    "Aston Villa": "AVL", "Brighton": "BHA", "West Ham": "WHU", "Everton": "EVE",
    "Crystal Palace": "CRY", "Brentford": "BRE", "Fulham": "FUL", "Wolverhampton Wanderers": "WOL",
    "Nottingham Forest": "NFO", "Bournemouth": "BOU", "Burnley": "BUR",
    "Leeds": "LEE", "Sunderland": "SUN", "Sheffield United": "SHU",
    "Luton": "LUT", "Ipswich": "IPS", "Leicester": "LEI", "Southampton": "SOU",
}


def _norm(s: str) -> str:
    """Strip accents, punctuation, case. 'Ødegaard' -> 'odegaard'."""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z ]", "", s.lower()).strip()


def match_players(fpl: pd.DataFrame, us: pd.DataFrame,
                  overrides: dict[int, str] | None = None) -> pd.DataFrame:
    """
    Join FPL players to Understat players.

    Strategy, in order:
      1. Manual override (data/name_map.csv) — always wins.
      2. Exact normalised full-name match within the same club.
      3. Exact normalised full-name match anywhere (catches transfers, which
         is precisely the Rogers case: FPL says Chelsea, Understat 2025/26
         says Aston Villa).
      4. Surname + first initial within club.
      5. Token-overlap best match above a similarity floor.

    Anything unmatched is REPORTED, not silently zeroed. Zeroed xG on a
    premium asset is how these tools quietly produce nonsense.
    """
    from difflib import SequenceMatcher

    overrides = overrides or {}
    us = us.copy()
    us["_n"] = us["understat_name"].map(_norm)
    us["_team"] = us["understat_team"].map(lambda t: TEAM_ALIASES.get(t, t[:3].upper()))
    us["_surname"] = us["_n"].map(lambda s: s.split()[-1] if s else "")

    by_name: dict[str, list] = {}
    for i, r in us.iterrows():
        by_name.setdefault(r["_n"], []).append(i)

    out = []
    for _, p in fpl.iterrows():
        pid = int(p["fpl_id"])
        idx, how = None, "unmatched"

        if pid in overrides:
            hit = us[us["understat_name"] == overrides[pid]]
            if len(hit):
                idx, how = hit.index[0], "override"

        full_n = _norm(p["full_name"])
        if idx is None and full_n in by_name:
            cands = by_name[full_n]
            same = [c for c in cands if us.at[c, "_team"] == p["team"]]
            idx, how = (same[0], "exact_same_club") if same else (cands[0], "exact_transferred")

        if idx is None:
            surname = _norm(p["web_name"]).split()[-1]
            initial = full_n[:1]
            cands = us[(us["_surname"] == surname)]
            if len(cands) == 1:
                idx, how = cands.index[0], "surname_unique"
            elif len(cands) > 1:
                same = cands[cands["_team"] == p["team"]]
                pool = same if len(same) else cands
                init = pool[pool["_n"].str.startswith(initial)]
                pool = init if len(init) else pool
                idx, how = pool.index[0], "surname_club"

        if idx is None:
            best, score = None, 0.0
            for i, r in us.iterrows():
                s = SequenceMatcher(None, full_n, r["_n"]).ratio()
                if r["_team"] == p["team"]:
                    s += 0.08
                if s > score:
                    best, score = i, s
            if score >= 0.82:
                idx, how = best, f"fuzzy_{score:.2f}"

        rec = dict(p)
        rec["match_method"] = how
        if idx is not None:
            for c in ["understat_id", "understat_name", "understat_team",
                      "u_xg90", "u_xa90", "u_npxg90", "shots", "key_passes"]:
                rec[c] = us.at[idx, c]
        out.append(rec)

    return pd.DataFrame(out)


def match_report(matched: pd.DataFrame, min_minutes: int = 450) -> pd.DataFrame:
    """Unmatched players who actually play — these need a manual name_map entry."""
    bad = matched[(matched["match_method"] == "unmatched")
                  & (matched["minutes"] >= min_minutes)]
    return bad[["fpl_id", "web_name", "full_name", "team", "position",
                "price", "minutes"]].sort_values("minutes", ascending=False)
