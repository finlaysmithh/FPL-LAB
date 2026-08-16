"""
Expected price rises and falls, from transfer momentum.

DELIBERATELY OUTSIDE THE xP MODEL. A price change is not a football event and
has no business moving a projection — a player is not better because people are
buying him. It belongs to the transfer planner, where "he rises tonight" is a
reason to act sooner and nothing more.

Measured on three seasons of real gameweek data, net transfers scaled by the
owner base against the NEXT gameweek's price change:

    season      r        n
    2023-24   +0.240   10,814
    2024-25   +0.278   11,004
    2025-26   +0.302   10,961

All three clear the r ~ 0.25 bar the assist-inflation signal cleared, with the
same sign and a p-value that is not close to interesting (1e-141 or smaller).
This is the one candidate of Task 30's three that survives, and it survives
easily — which is unsurprising, because FPL's price algorithm is literally
driven by net transfers. The correlation is not a discovery about football, it
is a partial reconstruction of a known mechanism.

What it cannot do: FPL's exact thresholds are undisclosed and change within a
season, and price moves are capped per player per day. So this ranks who is
CLOSE to moving; it does not promise a change tonight.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# Slope of next-gameweek price change on net-transfers-per-owner, pooled over
# the three measured seasons. Held as a single coefficient because the
# relationship is close to linear over the range that matters and a richer fit
# would be fitting FPL's undisclosed thresholds rather than the effect.
MOMENTUM_SLOPE = 0.28
MOMENTUM_R = 0.27


def price_pressure(transfers_in: pd.Series, transfers_out: pd.Series,
                   owners: pd.Series) -> pd.Series:
    """
    Net transfer momentum per existing owner — the quantity price moves track.

    Scaling by the owner base is what makes a 5,000-transfer swing on a 2%-owned
    differential comparable to the same swing on a 40%-owned template pick. In
    raw counts the template player always looks like he is moving and never is.
    """
    ti = pd.to_numeric(transfers_in, errors="coerce").fillna(0.0)
    to = pd.to_numeric(transfers_out, errors="coerce").fillna(0.0)
    own = pd.to_numeric(owners, errors="coerce").fillna(0.0).clip(lower=1.0)
    return (ti - to) / own


def expected_move(pressure: pd.Series) -> pd.Series:
    """Expected price change in £m for the coming gameweek."""
    return MOMENTUM_SLOPE * pd.to_numeric(pressure, errors="coerce").fillna(0.0)


def classify(pressure: pd.Series) -> pd.Series:
    """
    Rising / falling / steady, for a transfer planner to show.

    Deliberately three coarse buckets rather than a predicted price. The
    thresholds FPL uses are undisclosed and move within a season, so a figure
    like "+£0.07m tonight" would be false precision dressed up as a forecast.
    """
    p = pd.to_numeric(pressure, errors="coerce").fillna(0.0)
    return pd.cut(p, [-np.inf, -0.06, 0.06, np.inf],
                  labels=["falling", "steady", "rising"])
