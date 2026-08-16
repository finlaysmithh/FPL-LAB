"""
Per-gameweek availability, from FPL's own injury flags and news strings.

The bug this fixes: the engine carried `status` and `chance_of_playing` all the
way into the export and then never applied them. Garner was flagged `i`
(injured), 0% chance of playing, "Groin injury - Expected back 22 Aug" — and
still projected 84 expected minutes and 81 points across the half-season,
because `minutes.availability_multiplier` only runs inside `minutes.estimate`,
which `build_real.py` never calls.

Why this is not simply "set injured players to zero": FPL's
`chance_of_playing_next_round` means exactly what it says — the NEXT round. A
groin strain due back on 22 August costs a player the 21 August fixture and
nothing after it. Zeroing all nineteen gameweeks would be as wrong in the other
direction, and would quietly delete a fit player from the whole planner.

So availability is resolved per gameweek against real kickoff dates:

  * a parseable "Expected back <date>" zeroes every gameweek before that date
    and restores full availability after it
  * "Unknown return date" has no date to trust, so it applies a decaying
    penalty — full absence for `UNKNOWN_OUT_GWS` gameweeks, then a graded
    return rather than a cliff, because an unknown return is genuinely
    uncertain in both directions
  * a suspension behaves like a dated absence
  * `d` (doubtful) scales only the next round by `chance_of_playing`, which is
    the literal meaning of the field, and leaves later weeks alone
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

import numpy as np
import pandas as pd

# Statuses that mean "not available", as opposed to `d` (doubtful) and `a`.
HARD_OUT = {"i", "s", "u", "n"}

# With no stated return date, how many gameweeks to treat as a full absence
# before tapering back. Three is deliberately conservative: most "unknown"
# flags in FPL's feed are muscular problems measured in weeks, and the cost of
# over-rating an absent player (a wasted squad slot) is higher than the cost of
# under-rating one who returns early (a missed transfer).
UNKNOWN_OUT_GWS = 3
UNKNOWN_TAPER_GWS = 3

# A player who has LEFT is not injured — he is never coming back, and the
# graded-return taper that handles an unknown injury return is exactly wrong
# for him. Trevoh Chalobah, news "Has joined Como permanently", was projected
# at zero for three gameweeks and then eased back to 73 minutes a game and 45
# points across the horizon, at a club he does not play for.
#
# FPL leaves these in the registry with status `u` until the next data push, so
# the news string is the only signal there is.
GONE_PHRASES = (
    "joined", "has left", "left the club", "permanently", "transferred",
    "loan to", "on loan at", "no longer", "released", "retired",
)


def has_departed(status: str, news: str) -> bool:
    """True when the news says this player is not at the club any more."""
    if str(status or "").lower() != "u":
        return False
    n = str(news or "").lower()
    return any(p in n for p in GONE_PHRASES)


MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}

_DATE_RE = re.compile(r"(\d{1,2})\s+([A-Za-z]{3,9})")


def parse_return_date(news: str, season_start_year: int) -> datetime | None:
    """Pull a return date out of an FPL news string.

    FPL writes these as "Expected back 22 Aug" with no year, so the year is
    inferred from the season: Aug–Dec belong to the opening year, Jan–Jul to
    the next.
    """
    if not isinstance(news, str) or not news.strip():
        return None
    if "unknown return" in news.lower():
        return None
    m = _DATE_RE.search(news)
    if not m:
        return None
    day, month_word = int(m.group(1)), m.group(2)[:3].lower()
    month = MONTHS.get(month_word)
    if not month or not 1 <= day <= 31:
        return None
    year = season_start_year if month >= 7 else season_start_year + 1
    try:
        return datetime(year, month, day, tzinfo=timezone.utc)
    except ValueError:
        return None


def gw_kickoffs(fixtures: pd.DataFrame, gws: list[int]) -> dict[int, datetime]:
    """Earliest real kickoff per gameweek — the date a player must be fit for."""
    out = {}
    if "kickoff" not in fixtures.columns:
        return out
    f = fixtures.copy()
    f["_k"] = pd.to_datetime(f["kickoff"], errors="coerce", utc=True)
    for g in gws:
        sub = f[f["gw"] == g]["_k"].dropna()
        if len(sub):
            out[g] = sub.min().to_pydatetime()
    return out


def availability_by_gw(player: pd.Series, gws: list[int],
                       kickoffs: dict[int, datetime],
                       season_start_year: int) -> list[float]:
    """A multiplier in [0, 1] for each gameweek in `gws`."""
    status = str(player.get("status") or "a").lower()
    chance = player.get("chance_playing")
    news = player.get("news") or ""

    if has_departed(status, news):
        return [0.0] * len(gws)

    if status not in HARD_OUT and status != "d":
        return [1.0] * len(gws)

    if status == "d":
        # Doubtful applies to the next round only, which is what the field means.
        p = float(chance) / 100.0 if pd.notna(chance) else 0.5
        return [p if i == 0 else 1.0 for i in range(len(gws))]

    back = parse_return_date(news, season_start_year)
    out = []
    if back is not None:
        for g in gws:
            ko = kickoffs.get(g)
            out.append(0.0 if (ko is not None and ko < back) else 1.0)
        return out

    # No stated return date: full absence, then a graded return.
    for i, _ in enumerate(gws):
        if i < UNKNOWN_OUT_GWS:
            out.append(0.0)
        elif i < UNKNOWN_OUT_GWS + UNKNOWN_TAPER_GWS:
            step = (i - UNKNOWN_OUT_GWS + 1) / (UNKNOWN_TAPER_GWS + 1)
            out.append(round(float(step), 3))
        else:
            out.append(1.0)
    return out


def attach_availability(players: pd.DataFrame, fixtures: pd.DataFrame,
                        gws: list[int], season_start_year: int = 2026) -> pd.DataFrame:
    """Add an `avail_by_gw` column: one multiplier per requested gameweek."""
    ko = gw_kickoffs(fixtures, gws)
    rows = [availability_by_gw(p, gws, ko, season_start_year)
            for _, p in players.iterrows()]
    out = players.copy()
    out["avail_by_gw"] = rows
    out["avail_next"] = [r[0] if r else 1.0 for r in rows]
    return out
