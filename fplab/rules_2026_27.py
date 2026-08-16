"""
2026/27 rule changes and their effect on projections.

Confirmed by the Premier League on 20 July 2026 (fantasy.premierleague.com/en/help/new):

WHAT DID NOT CHANGE
  * Defensive Contribution (DefCon) thresholds are UNCHANGED: 10 CBIT for
    defenders, 12 CBIRT for midfielders and forwards, capped at +2 per match.
    Despite community pressure to reward defensive milestones further, FPL
    left the mechanic alone.
  * The chip system is unchanged: two each of Wildcard, Free Hit, Triple
    Captain and Bench Boost (eight total), with the first set expiring at the
    GW19 deadline.
  * Five rolled-over free transfers remain.
  * Goals, assists, clean sheets and appearance points are unchanged.

WHAT DID CHANGE — and it moves player values
  FPL reduced the weight of CBI (clearances, blocks, interceptions) inside the
  Bonus Points System. In their own words, they saw 112 occasions where
  defenders collected both DefCon and bonus points largely off the same CBI
  actions, and cut the overlap.

  Their stated knock-on effects:
    - central defenders: slightly LESS likely to earn bonus on a clean sheet
    - full-backs and goalkeepers: MORE likely to earn bonus

WHY THIS MATTERS TO THE MODEL
  Every prior-season BPS rate in this dataset was earned under the OLD rules.
  Projecting 2026/27 bonus straight off last season's BPS therefore
  systematically overrates CBI-heavy centre-backs and underrates keepers,
  full-backs and attackers.

  Measured on the real 2025/26 season (players over 1500 minutes), the share
  of a player's BPS coming from CBI was:

      DEF  23.4%      MID   6.8%      FWD  4.9%      GK  4.3%

  So the change is ~5x more consequential for defenders than anyone else, and
  worst for low-BPS stoppers whose bonus was almost entirely CBI-driven
  (Kilman 90%, Estève 55%, Ekdal 47%).

IMPLEMENTATION
  Under the old BPS, 2 CBI earned 1 BPS. We estimate each player's CBI-derived
  BPS from real CBI counts, scale that component down by CBI_BPS_RETAINED, and
  renormalise so total bonus awarded per match stays constant at 6 (3+2+1).
  Bonus is a RANK statistic, so removing BPS from centre-backs mechanically
  hands bonus to everyone else — which reproduces FPL's stated effect rather
  than hard-coding it.

  CBI_BPS_RETAINED is the one judgement call: FPL published the direction but
  not the new coefficient. 0.5 (halved) is the default. Change it here when
  the exact value is confirmed, and every projection updates.
"""
from __future__ import annotations

import pandas as pd

# Old BPS rule: 2 CBI = 1 BPS.
CBI_PER_BPS = 2.0

# Fraction of the old CBI-to-BPS contribution retained in 2026/27.
# FPL confirmed the weight was reduced but not by how much; 0.5 is our estimate.
CBI_BPS_RETAINED = 0.5

# Unchanged for 2026/27 — kept here so the rules live in one place.
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12, "GK": None}
DEFCON_POINTS = 2
CHIPS = {
    "wildcard": 2, "free_hit": 2, "triple_captain": 2, "bench_boost": 2,
}
FIRST_CHIP_SET_EXPIRY_GW = 19
MAX_FREE_TRANSFERS = 5


def adjust_bps_for_2026_27(
    players: pd.DataFrame,
    cbi90_col: str = "cbi90_prior",
    bps90_col: str = "bps90_prior",
    retained: float = CBI_BPS_RETAINED,
    renormalise: bool = True,
) -> pd.DataFrame:
    """
    Re-express last season's BPS rate under the 2026/27 CBI weighting.

    Adds:
        bps90_old        the untouched prior rate
        cbi_bps90        estimated BPS that came from CBI
        bps90_prior      adjusted rate (this is what the model then uses)
        bps_delta_pct    % change, so you can see who gains and who loses
    """
    df = players.copy()
    if cbi90_col not in df.columns:
        df[cbi90_col] = 0.0

    cbi90 = pd.to_numeric(df[cbi90_col], errors="coerce").fillna(0.0)
    bps90 = pd.to_numeric(df[bps90_col], errors="coerce").fillna(0.0)

    cbi_bps = (cbi90 / CBI_PER_BPS).clip(upper=bps90)   # can't exceed total
    adjusted = bps90 - cbi_bps * (1.0 - retained)

    if renormalise:
        # Bonus is rank-based and the total awarded per match is fixed, so the
        # league-wide mean BPS should not fall — only its distribution shifts.
        played = bps90 > 0
        if played.any() and adjusted[played].mean() > 0:
            adjusted = adjusted * (bps90[played].mean() / adjusted[played].mean())

    df["bps90_old"] = bps90
    df["cbi_bps90"] = cbi_bps
    df[bps90_col] = adjusted
    delta = (adjusted - bps90) / bps90.where(bps90 > 0) * 100
    df["bps_delta_pct"] = pd.to_numeric(delta, errors="coerce").fillna(0.0).round(1)
    return df


def rule_change_report(df: pd.DataFrame, min_minutes: float = 1200) -> dict:
    """Who gains and who loses under the 2026/27 BPS recalibration."""
    d = df.copy()
    if "prior_minutes" in d.columns:
        d = d[pd.to_numeric(d["prior_minutes"], errors="coerce").fillna(0) >= min_minutes]
    d = d[d["bps90_old"] > 0]
    cols = ["web_name", "team", "position", "price", "bps90_old",
            "bps90_prior", "bps_delta_pct"]
    cols = [c for c in cols if c in d.columns]
    return {
        "by_position": d.groupby("position")["bps_delta_pct"].mean().round(1).to_dict(),
        "biggest_losers": d.nsmallest(10, "bps_delta_pct")[cols].round(2),
        "biggest_gainers": d.nlargest(10, "bps_delta_pct")[cols].round(2),
    }
