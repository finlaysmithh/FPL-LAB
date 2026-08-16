"""
Season blending by credibility weighting (shrinkage), not fixed ratios.

The naive approach is "70% this season, 30% last season".  That is wrong in
both directions: in GW2 it massively over-weights a two-game sample, and in
GW30 it still drags in stale data.

The correct weight depends on SAMPLE SIZE, not the calendar:

    w_now = n / (n + K)

where n = 90s played this season and K is the credibility constant (the
number of 90s at which you trust current and prior data equally).

    GW1   n=0    -> w=0.00   100% prior
    GW8   n=8    -> w=0.50   even split
    GW20  n=19   -> w=0.70
    GW38  n=36   -> w=0.82

K differs by metric because metrics stabilise at different rates.  Shot volume
and defensive actions are high-frequency and stabilise fast (low K); conversion
and assists are low-frequency and noisy (high K).

New signings are flagged with an asterisk and given a LOWER K, so that real
Premier League data overrides the carried prior quickly. How the prior itself
crosses a transfer depends on whether there is a Premier League record to cross:

  - A player with PL history carries his SHARE of his old club's chances, not
    his raw per-90, and it is restated here against his new club's creation.
    Carrying the rate instead made every move to a stronger side read as a
    demotion, because `xpts` divides the carried rate by the CURRENT club's
    xG90 to recover a share. See `fplab.player_history` for the derivation and
    the out-of-sample numbers.
  - A genuine import has no PL share to carry, so his foreign rate goes
    through `adjust_foreign_rate`: a league strength factor and a dampened
    team-context ratio.
"""
from __future__ import annotations

import pandas as pd

from .config import (
    ASSIST_CRED_K,
    ASSIST_CREDIBILITY,
    ASSIST_RATIO_CLIP,
    FPL_ASSIST_INFLATION,
    LEAGUE_STRENGTH,
    SHRINK_K_ATTACK,
    SHRINK_K_BPS,
    SHRINK_K_DEFCON,
    SHRINK_K_MINUTES,
    SHRINK_K_NEW_SIGNING,
)


def credibility(n90: float, k: float) -> float:
    """Weight on current-season data given n 90s played."""
    return float(n90 / (n90 + k)) if (n90 + k) > 0 else 0.0


def blend_rate(now: float, prior: float, n90: float, k: float) -> float:
    w = credibility(n90, k)
    return w * now + (1 - w) * prior


def assist_multiplier(
    assists: float,
    xa: float,
    position: str,
    credibility: float = ASSIST_CREDIBILITY,
    k: float = ASSIST_CRED_K,
) -> float:
    """
    How much more often than xA suggests does THIS player pick up FPL assists?

    FPL pays for assists Opta's xA never counts — a won penalty that is scored,
    a shot parried to a team-mate, a deflection, a second ball — which is worth
    ~1.38 assists per 1.0 xA league-wide. `config.FPL_ASSIST_INFLATION` carries
    that as one constant per position, and this function lets a player move off
    it by the small amount his own record has actually earned.

    That much is measured, not assumed. Year over year the ratio repeats at
    r = +0.25, while the analogous FINISHING overperformance repeats at r = 0.05
    — which is why goals get no matching treatment and must not be given one.

    The shrink is the same shape `ratings._shrink_venue_splits` applies to a
    club's home/away split, and for the same reason: keep the league-wide effect
    (which is real and stable), and pull each individual's personal deviation
    from it most of the way out.

        w      = credibility * xa/(xa + k)
        result = (1 - w) * positional_constant + w * own_ratio

    with `credibility` capping w at 0.25 no matter how much evidence a player
    accumulates, because 0.25 is all the signal there is. See
    config.ASSIST_CREDIBILITY for the derivation and the out-of-sample check.

    `xa` doubles as the sample size, so a player with no xA on record simply
    gets the positional constant back.
    """
    prior = FPL_ASSIST_INFLATION.get(position, 1.33)
    xa = float(xa or 0.0)
    if xa <= 0:
        return prior
    lo, hi = ASSIST_RATIO_CLIP
    own = min(max(float(assists or 0.0) / xa, lo), hi)
    w = credibility * (xa / (xa + k))
    return (1 - w) * prior + w * own


def adjust_foreign_rate(
    rate: float,
    from_league: str,
    old_team_xg90: float,
    new_team_xg90: float,
) -> float:
    """
    Translate a player's production rate from another league into PL terms.

    Two corrections:
      1. League strength — Ligue 1 output is worth ~0.88 of PL output.
      2. Team context — a player moving from a 1.1 xG/90 side to a 2.0 xG/90
         side gets more chances; scale by the ratio of team creation.

    Team context is dampened with a square root: a player does not simply
    inherit his new team's output proportionally.
    """
    lg = LEAGUE_STRENGTH.get(from_league, LEAGUE_STRENGTH["Other"])
    ctx = 1.0
    if old_team_xg90 and old_team_xg90 > 0:
        ctx = (new_team_xg90 / old_team_xg90) ** 0.5
    return rate * lg * ctx


def build_player_rates(players: pd.DataFrame, team_xg90: dict[str, float]) -> pd.DataFrame:
    """
    Produce blended per-90 rates for every player.

    Expected `players` columns
    --------------------------
    id, name, team, position, price
    n90_now, xg90_now, xa90_now, defcon90_now, mins_share_now, bps90_now
    n90_prior, xg90_prior, xa90_prior, defcon90_prior, mins_share_prior, bps90_prior
    is_new_signing (bool), prior_league (str), prior_team_xg90 (float)

    Returns the frame with *_blend columns and a `provisional` flag.
    """
    df = players.copy()
    out = []

    for _, p in df.iterrows():
        new = bool(p.get("is_new_signing", False))
        k_att = SHRINK_K_NEW_SIGNING if new else SHRINK_K_ATTACK
        k_def = SHRINK_K_NEW_SIGNING if new else SHRINK_K_DEFCON
        k_min = SHRINK_K_NEW_SIGNING if new else SHRINK_K_MINUTES

        new_team_xg = team_xg90.get(p["team"], 1.45)
        prior_xg, prior_xa, prior_dc = p["xg90_prior"], p["xa90_prior"], p["defcon90_prior"]

        # ---- carry the SHARE, not the rate --------------------------------
        # `player_history` measured what fraction of his club's chances the
        # player owned, against the club he was at when he earned it, shrunk
        # toward his positional mean by minutes. This is the one place that
        # knows where he plays NOW, so this is where the share becomes a rate
        # again. Without it, `xpts.player_xp` divides a rate earned at a weak
        # club by a strong club's creation and reads the transfer as a
        # demotion: 0.50 xG90 at a 1.2-xG90 side is a 42% share, but 0.50/1.9
        # at his new club looks like 26%.
        sh_g = p.get("xg_share_prior")
        sh_a = p.get("xa_share_prior")
        carried_share = sh_g is not None and pd.notna(sh_g)
        if carried_share:
            prior_xg = float(sh_g) * new_team_xg
            if sh_a is not None and pd.notna(sh_a):
                prior_xa = float(sh_a) * new_team_xg

        # A player with a carried share needs no foreign translation: the share
        # is PL-measured by construction, and `adjust_foreign_rate` would apply
        # the club-context correction a second time. Only a player with no PL
        # record — a genuine import — takes that path.
        if new and not carried_share:
            old_xg = p.get("prior_team_xg90", 1.45) or 1.45
            lg = p.get("prior_league", "Other")
            prior_xg = adjust_foreign_rate(prior_xg, lg, old_xg, new_team_xg)
            prior_xa = adjust_foreign_rate(prior_xa, lg, old_xg, new_team_xg)
            # Defensive volume travels better than attacking output.
            prior_dc = prior_dc * (0.5 + 0.5 * LEAGUE_STRENGTH.get(lg, 0.65))

        n = float(p["n90_now"])
        rec = dict(p)
        rec["xg90_blend"] = blend_rate(p["xg90_now"], prior_xg, n, k_att)
        rec["xa90_blend"] = blend_rate(p["xa90_now"], prior_xa, n, k_att)
        rec["defcon90_blend"] = blend_rate(p["defcon90_now"], prior_dc, n, k_def)
        # BPS gets its own K, measured: it is roughly twice as noisy as the
        # attacking rates it used to share a constant with. See config.
        k_bps = SHRINK_K_NEW_SIGNING if new else SHRINK_K_BPS
        rec["bps90_blend"] = blend_rate(p["bps90_now"], p["bps90_prior"], n, k_bps)
        rec["mins_share_blend"] = blend_rate(
            p["mins_share_now"], p["mins_share_prior"], n, k_min
        )
        rec["w_current"] = credibility(n, k_att)

        # Assist inflation pools BOTH seasons rather than blending two ratios.
        # The quantity is a ratio of small counts, so adding the evidence up and
        # dividing once is the right estimator; blending a 12-assist season with
        # a 1-assist start would let three games of noise move a career figure.
        # A new signing's foreign record is dropped, not translated: leagues
        # differ in how often they award the deflected, scrappy assists this
        # correction exists to capture, and there is no measurement of that gap.
        a_tot = 0.0 if new else float(p.get("assists_prior", 0.0) or 0.0)
        xa_tot = 0.0 if new else float(p.get("xa_total_prior", 0.0) or 0.0)
        a_tot += float(p.get("assists_now", 0.0) or 0.0)
        xa_tot += float(p.get("xa_total_now", 0.0) or 0.0)
        rec["assist_mult"] = assist_multiplier(a_tot, xa_tot, p["position"])
        rec["assist_xa_sample"] = xa_tot

        # Provisional = still leaning on imported/foreign data.
        rec["provisional"] = new and rec["w_current"] < 0.6
        out.append(rec)

    res = pd.DataFrame(out)

    # Display name: prefer FPL's own `web_name` (what the game itself shows on
    # a shirt), falling back to `name` then `full_name`. Deriving it from the
    # prior-season merge instead produced the literal string "nan" for 110
    # players — every new signing, who by definition has no prior-season row.
    def _label(r):
        for key in ("web_name", "name", "full_name"):
            v = r.get(key)
            if isinstance(v, str) and v.strip() and v.strip().lower() != "nan":
                return v.strip()
        return f"Player {r.get('fpl_id', r.get('id', '?'))}"

    res["display_name"] = res.apply(
        lambda r: _label(r) + ("*" if r["provisional"] else ""), axis=1
    )
    return res
