"""
Minutes model.

The single largest source of error in any xP system. A perfect xG model on a
player who is benched scores zero. My first version used
`p_60 = p_play * 0.88`, which is a made-up constant — this replaces it.

We estimate two quantities per player per gameweek:

    p_play  probability of any appearance
    p_60    probability of 60+ minutes (the 2-point threshold, and the gate on
            clean sheet and goals-conceded terms)

Inputs, in descending order of signal:

  1. Start rate over recent matches, exponentially decayed. A player who has
     started the last 4 is a different proposition to one who started 4 of 12.
  2. Minutes-per-start. Distinguishes a nailed 90-minute player from one
     habitually hooked on 65.
  3. FPL availability flags: status (a/d/i/s/u) and chance_of_playing.
     Status 'i'/'s'/'u' is a hard zero — no amount of xG rescues a suspended
     player, and the optimiser must never buy one.
  4. Rotation risk from fixture congestion: European nights and cup rounds in
     the same week measurably depress start probability at big clubs.
  5. Early-season shrinkage toward last season's minutes share, using the same
     credibility logic as the attacking rates.

Everything is bounded to [0, 1] and p_60 <= p_play by construction.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

STATUS_HARD_ZERO = {"i", "s", "u"}
START_HALFLIFE = 4.0          # matches
CONGESTION_PENALTY = 0.88     # multiplier when a midweek fixture is in the week


def _curves_p60(share: float) -> float:
    """P(60 minutes) from the curve fitted in fplab.fit_minutes."""
    from .roles import load_curves
    return float(np.clip(np.power(np.clip(share, 0.0, 1.0),
                                  load_curves()["p_60_exp"]), 0.0, 1.0))


def _decayed_rate(flags: list[int], halflife: float = START_HALFLIFE) -> float:
    """Exponentially weighted mean of a binary sequence, most recent last."""
    if not flags:
        return np.nan
    n = len(flags)
    w = 0.5 ** (np.arange(n - 1, -1, -1) / halflife)
    return float(np.average(flags, weights=w))


def minutes_from_history(history: list[dict]) -> dict:
    """
    Derive minutes signals from a player's element-summary `history` list
    (one entry per gameweek this season).
    """
    if not history:
        return {"start_rate": np.nan, "mins_per_start": np.nan,
                "p60_rate": np.nan, "n_matches": 0}

    starts = [1 if (h.get("starts") or 0) > 0 else 0 for h in history]
    mins = [float(h.get("minutes", 0) or 0) for h in history]
    started_mins = [m for m, s in zip(mins, starts) if s]
    p60 = [1 if m >= 60 else 0 for m in mins]

    return {
        "start_rate": _decayed_rate(starts),
        "mins_per_start": float(np.mean(started_mins)) if started_mins else np.nan,
        "p60_rate": _decayed_rate(p60),
        "n_matches": len(history),
    }


def availability_multiplier(status: str, chance: float | None) -> float:
    """
    FPL flags -> multiplier.

    'a' available, 'd' doubtful, 'i' injured, 's' suspended, 'u' unavailable.
    Doubtful uses chance_of_playing_next_round directly when present; when the
    flag is 'd' with no percentage, assume 50% — that is what the flag means.
    """
    if status in STATUS_HARD_ZERO:
        return 0.0
    if chance is not None and not pd.isna(chance):
        return float(chance) / 100.0
    if status == "d":
        return 0.5
    return 1.0


def estimate(
    player: pd.Series,
    prior_mins_share: float | None = None,
    credibility_k: float = 5.0,
    congested: bool = False,
) -> dict:
    """
    Combine every signal into p_play, p_60 and expected minutes fraction.

    Returns dict with p_play, p_60, mins_frac (expected minutes / 90).
    """
    n = float(player.get("n90_now", 0) or 0)
    start_rate = player.get("start_rate", np.nan)
    p60_rate = player.get("p60_rate", np.nan)
    mps = player.get("mins_per_start", np.nan)

    # Fall back to season-aggregate minutes share where per-GW history is absent.
    if pd.isna(start_rate):
        start_rate = float(player.get("mins_share_now", 0) or 0)
    if pd.isna(p60_rate):
        # P(60) from the fitted curve, not from a flat `* 0.9`. The old
        # constant was roughly right in the middle of the range and badly wrong
        # at the top: at a 0.90 minutes share it gave 0.81 against a measured
        # 0.90, and P(60) gates appearance points, clean sheets and the
        # goals-conceded penalty at once, so the error landed three times on
        # the same player. See fplab.fit_minutes for the fit.
        p60_rate = float(_curves_p60(start_rate))
    if pd.isna(mps):
        mps = 78.0

    # Credibility blend with last season, same shrinkage logic as the rates.
    if prior_mins_share is not None and not pd.isna(prior_mins_share):
        w = n / (n + credibility_k)
        start_rate = w * start_rate + (1 - w) * prior_mins_share
        p60_rate = w * p60_rate + (1 - w) * (prior_mins_share * 0.9)

    avail = availability_multiplier(player.get("status", "a"),
                                    player.get("chance_playing"))
    congestion = CONGESTION_PENALTY if congested else 1.0

    # Sub appearances: a non-starter still has some chance of coming on.
    p_start = float(np.clip(start_rate * avail * congestion, 0, 1))
    p_sub = float(np.clip((1 - p_start) * 0.35 * avail, 0, 1))
    p_play = float(np.clip(p_start + p_sub, 0, 1))

    p_60 = float(np.clip(p60_rate * avail * congestion, 0, p_play))

    # Expected minutes: starters play mins_per_start, subs ~20.
    exp_mins = p_start * mps + p_sub * 20.0
    return {
        "p_play": p_play,
        "p_60": p_60,
        "p_start": p_start,
        "mins_frac": float(np.clip(exp_mins / 90.0, 0, 1)),
    }


def price_informed_prior(
    players: pd.DataFrame,
    price_col: str = "price",
    pos_col: str = "position",
    mins_col: str = "mins_share_prior",
    min_minutes_frac: float = 0.5,
    band: float = 0.75,
) -> pd.Series:
    """
    Expected minutes share implied by PRICE, fitted from real data.

    Why this exists: raw minutes share from last season is a poor forward
    estimate for anyone who missed time. Isak played 694 minutes in 2025/26
    (injury plus a transfer saga) giving a 0.20 minutes share — which projected
    him at 4.6 points over six gameweeks, absurd for a £9.0m nailed striker
    who takes Liverpool's penalties.

    Price is the single best available proxy for expected minutes, because it
    encodes the market's consensus on whether a player starts. FPL prices are
    set by the game's own analysts pre-season and then move on transfer demand.

    Method: for each player, take the median minutes share of players in the
    same position within ±`band` of his price, counting only those who played
    at least `min_minutes_frac` of a season. Restricting to that group is
    deliberate — we are asking "what does a FIT player at this price play?",
    not "what is the average outcome at this price", which would bake the very
    injury effect we are trying to correct for back into the answer.
    """
    out = pd.Series(index=players.index, dtype=float)
    for pos, grp in players.groupby(pos_col):
        fit_pool = grp[grp[mins_col] >= min_minutes_frac]
        for i, row in grp.iterrows():
            p = float(row[price_col])
            near = fit_pool[(fit_pool[price_col] - p).abs() <= band]
            if len(near) >= 3:
                out.at[i] = float(near[mins_col].median())
            elif len(fit_pool):
                out.at[i] = float(fit_pool[mins_col].median())
            else:
                out.at[i] = 0.6
    return out.fillna(0.6)


SEASON_MINUTES = 38 * 90        # 3420
FRINGE_MINUTES = 1200.0         # above this a player has earned normal treatment
NEW_SIGNING_MINUTES = 180.0     # below this AND newly arrived = minutes unknown


def minutes_guard(
    players: pd.DataFrame,
    k_minutes: float = 900.0,
    fringe_minutes: float = FRINGE_MINUTES,
    new_signing_minutes: float = NEW_SIGNING_MINUTES,
) -> pd.DataFrame:
    """
    Shrink observed minutes share toward the price-implied expectation, then
    apply a two-tier ceiling.

        w = observed_minutes / (observed_minutes + K)

    A player with 3000 minutes is trusted almost entirely on his record
    (w=0.77). A player with 694 minutes carries real ambiguity — we cannot
    tell a rotation player from an injured starter from the total alone — so
    he leans toward what his price implies (w=0.44).

    Two-tier guard
    --------------
    The previous single flat cap (0.45 for anyone under 180 minutes) conflated
    two opposite situations and got both wrong:

    * **Fringe** — a player who was in a Premier League squad all of 2025/26
      and still barely played. That is not missing data, it is evidence. A
      full season of availability and 265 minutes says third or fourth choice.
      Marc Guiu (265 mins, £5.0m) was blending to a 0.53 share — 47 minutes a
      game — and with `price_implied_production` handing him a plausible xG/90
      he surfaced near the top of xP-per-£m. He has no realistic route to
      minutes.
    * **New signing** — genuinely unknown. Foreign-league minutes are not
      reachable from here (Understat blocks datacentre IPs; the open
      multi-league datasets stop at 2021/22), so price stands in, exactly as
      the README argues. These players must NOT be thrown out with the fringe.

    Ceilings, each scaled by price percentile **within position** (a £6.0m
    defender is expensive, a £6.0m midfielder is not — ranking on raw price
    across positions flatters cheap forwards, which is the precise failure
    mode here):

        observed_share = prior_minutes / 3420
        fringe_cap     = clip(0.10 + 0.25*price_pct + 0.90*observed_share, 0.06, 0.75)
        signing_cap    = clip(0.20 + 0.60*price_pct, 0.20, 0.85)

    Routing: `prior_minutes < 180` **and** flagged `is_new_signing` takes the
    signing path. Everything else under `fringe_minutes` takes the fringe
    path — including a player labelled a new signing who does have 180+ PL
    minutes, because we have evidence about him. Above `fringe_minutes` no
    ceiling binds at all.

    These constants are hand-picked, not fitted — see README "Known limits".

    Returns a frame with `mins_share_raw`, `minutes_ceiling`, `mins_share`,
    `exp_mins` and `minutes_flag` ('' / 'fringe' / 'new_signing_price_proxy').
    """
    prior = price_informed_prior(players)
    observed = players["mins_share_prior"].fillna(0.0)
    mins = players.get("prior_minutes")
    if mins is None:
        mins = observed * SEASON_MINUTES
    mins = pd.to_numeric(mins, errors="coerce").fillna(observed * SEASON_MINUTES)

    w = mins / (mins + k_minutes)
    blended = (w * observed + (1 - w) * prior).clip(0.0, 1.0)
    raw = blended.copy()

    # Price percentile WITHIN position.
    if "position" in players.columns:
        price_pct = players.groupby("position")["price"].rank(pct=True)
    else:
        price_pct = players["price"].rank(pct=True)
    price_pct = price_pct.fillna(0.5)

    observed_share = (mins / SEASON_MINUTES).clip(0.0, 1.0)
    is_signing = players.get("is_new_signing")
    if is_signing is None:
        is_signing = pd.Series(False, index=players.index)
    is_signing = is_signing.fillna(False).astype(bool)

    signing_path = (mins < new_signing_minutes) & is_signing
    fringe_path = (mins < fringe_minutes) & ~signing_path

    ceiling = pd.Series(1.0, index=players.index, dtype=float)
    flag = pd.Series("", index=players.index, dtype=object)

    ceiling[fringe_path] = (0.10 + 0.25 * price_pct[fringe_path]
                            + 0.90 * observed_share[fringe_path]).clip(0.06, 0.75)
    flag[fringe_path] = "fringe"

    ceiling[signing_path] = (0.20 + 0.60 * price_pct[signing_path]).clip(0.20, 0.85)
    flag[signing_path] = "new_signing_price_proxy"

    blended = pd.concat([blended, ceiling], axis=1).min(axis=1)

    # Clear-#1 goalkeeper floor
    # -------------------------
    # GK minutes are bimodal: a fit first choice plays 90 or nothing. Linear
    # shrinkage treats an injury-shortened season as evidence of rotation, so
    # Alisson (2,340 real minutes, share 0.74 after blending) projected below
    # £5.0m starters like Kelleher — backtest GK coefficients are too weak to
    # correct that. Where a club has ONE strictly highest-priced keeper with a
    # real PL record, the market is unambiguous about who starts, and the
    # right forward estimate is what a FIT keeper at that price plays (the
    # same fit-player pool `price_informed_prior` already builds). Floor him
    # there. Backups are untouched, as are clubs where prices tie — a genuine
    # selection battle is exactly when the blend should stay cautious.
    if {"position", "team", "price"}.issubset(players.columns):
        gk = players[players["position"] == "GK"]
        for _, grp in gk.groupby("team"):
            if len(grp) < 2:
                continue
            top_price = grp["price"].max()
            top = grp[grp["price"] == top_price]
            if len(top) != 1:
                continue                      # tied prices: real competition
            i = top.index[0]
            if mins.at[i] < 900:
                continue                      # no real PL record: keep the cap
            if blended.at[i] < float(prior.at[i]):
                blended.at[i] = float(prior.at[i])
                ceiling.at[i] = 1.0           # floor deliberately beats the cap
                flag.at[i] = "clear_first_choice_gk"

    # Declared fit starters
    # ---------------------
    # Shrinkage cannot tell an injured starter from a rotation player: both
    # arrive as "not many minutes", and the blend splits the difference. That
    # is the right default under genuine ambiguity, but it is the wrong answer
    # when the ambiguity has already been resolved — a player who missed most
    # of last season with a known long-term injury and is fit and starting now
    # has last season's minutes as an *explanation*, not as evidence about what
    # he will play. Isak is the case the module docstring already cites: 694
    # minutes from injury plus a transfer saga, blended to roughly half a
    # season, for a nailed striker who will start every week.
    #
    # There is no way to infer this from the data we hold, so it is a declared
    # input: set `fit_starter` in data/overrides.csv and he is floored at what
    # a FIT player of his price plays — the same fit-player pool, and exactly
    # the same manoeuvre, as the clear-#1 goalkeeper floor above. It floors
    # rather than overwrites, so a player whose own record is already stronger
    # than his price implies keeps his record.
    #
    # The floor uses a STRICTER reference pool than the ordinary price prior.
    # `price_informed_prior` defaults to players who managed at least half a
    # season, which is the right question for "is this player fit?" but the
    # wrong one here: half that pool are rotation players, and their median
    # drags a declared starter down to ~57 minutes a game. Declaring someone a
    # fit starter is a claim that he holds a starting role, so the reference
    # is players who actually held one — hence 0.65.
    if "fit_starter" in players.columns:
        declared = _truthy(players["fit_starter"])
        if declared.any():
            nailed = price_informed_prior(players, min_minutes_frac=0.65)
            for i in players.index[declared]:
                floor = float(nailed.at[i])
                if blended.at[i] < floor:
                    blended.at[i] = floor
                    ceiling.at[i] = 1.0
                    flag.at[i] = "declared_fit_starter"

    # A hand-set minutes share beats every model path, including the floors
    # above. For when you know something the model cannot: a pre-season
    # interview, a confirmed role change, a manager naming his XI.
    if "mins_share_override" in players.columns:
        manual = pd.to_numeric(players["mins_share_override"], errors="coerce")
        for i in players.index[manual.notna()]:
            blended.at[i] = float(np.clip(manual.at[i], 0.0, 1.0))
            ceiling.at[i] = 1.0
            flag.at[i] = "manual_minutes"

    return pd.DataFrame({
        "mins_share_raw": raw,
        "minutes_ceiling": ceiling,
        "mins_share": blended,
        "exp_mins": blended * 90.0,
        "minutes_flag": flag,
    })


def _truthy(col: pd.Series) -> pd.Series:
    """
    CSV booleans arrive as whatever the file happened to contain — True, TRUE,
    'true', 'yes', 1 — and a column with any blank cell comes back as object
    dtype, where `.astype(bool)` would read the string 'False' as True.
    """
    if col.dtype == bool:
        return col
    return (col.astype(str).str.strip().str.lower()
            .isin({"true", "yes", "y", "1"}))


def blended_minutes_share(players: pd.DataFrame, **kw) -> pd.Series:
    """Final guarded minutes share. See `minutes_guard` for the full detail."""
    return minutes_guard(players, **kw)["mins_share"]


def no_history_mask(players: pd.DataFrame, no_history_minutes: float = 180.0) -> pd.Series:
    """Players whose minutes projection is a guess, not an estimate."""
    mins = pd.to_numeric(players.get("prior_minutes", 0), errors="coerce").fillna(0.0)
    return mins < no_history_minutes


def price_implied_production(
    players: pd.DataFrame,
    cols: tuple = ("xg90_prior", "xa90_prior", "defcon90_prior", "bps90_prior"),
    price_col: str = "price",
    pos_col: str = "position",
    minutes_col: str = "prior_minutes",
    career_col: str = "career_n90",
    career_k: float = 10.0,
    fit_min_minutes: float = 1500.0,
    band: float = 0.75,
    damping: float = 0.85,
) -> pd.DataFrame:
    """
    Give players with no usable Premier League history a production prior
    implied by their price, instead of leaving them at zero.

    Why: a transfer from abroad has no PL record, so every rate is 0 and the
    model treats him as worthless. Rashford (a season on loan at Barcelona),
    Kulusevski and N.Jackson were all projecting zero attacking output despite
    £6.5m+ price tags. A zero is not a neutral guess — it is a confident and
    wrong one.

    We cannot obtain their foreign-league xG from any source reachable here
    (Understat blocks datacentre IPs; the open multi-league datasets on GitHub
    stop at 2021/22). So price becomes the proxy: FPL's own analysts set
    pre-season prices with full knowledge of a signing's overseas record, which
    makes price a compressed expert estimate of exactly the production we're
    missing.

    Method: for each such player, take the median rate of same-position players
    within ±`band` of his price who played at least `fit_min_minutes`, then
    damp by `damping` — new arrivals typically need time to settle, and the
    fitted pool is survivor-biased toward players who held their place.

    The estimate is a PRIOR, not a verdict: a player with Premier League
    history keeps it in proportion to how much of it there is (see `career_k`
    below), so the proxy only takes over completely for someone the league has
    genuinely never seen. `rate_mostly_price` marks the players it does
    dominate, which is the set the UI should be honest about.

    These players keep their `*` flag. Replace the estimate with real numbers
    in data/overrides.csv the moment you have a view worth more than a proxy.
    """
    df = players.copy()
    mins = pd.to_numeric(df.get(minutes_col, 0), errors="coerce").fillna(0.0)
    needs = mins < 180

    # How much Premier League football the player has on record ACROSS SEASONS,
    # not just in the one season `minutes_col` looks at. This is the difference
    # between "we have never seen him" and "we did not see him last year", and
    # the old code could not tell them apart: `needs` keys off last season
    # alone, so a year abroad or injured erased everything before it.
    #
    # Measured cost of that, on the 2026/27 registry: 242 players had their
    # rates replaced by a price-band median, and 28 of them had 20+ full
    # matches of PL evidence. Rashford's own 0.312 xG90 over 72.9 matches
    # became 0.160; Maddison's 0.262 over 71.3 became 0.146 — the same number
    # Kulusevski got, because at £6.5m they share a price band. Two players
    # with entirely different records arriving at GW1 indistinguishable is the
    # exact failure the price proxy was never meant to cause.
    career = pd.to_numeric(df.get(career_col, 0.0), errors="coerce").fillna(0.0)

    for pos, grp in df.groupby(pos_col):
        pool = grp[
            pd.to_numeric(grp.get(minutes_col, 0), errors="coerce").fillna(0.0)
            >= fit_min_minutes
        ]
        if pool.empty:
            continue
        for i in grp.index:
            if not needs.loc[i]:
                continue
            p = float(df.at[i, price_col])
            near = pool[(pool[price_col] - p).abs() <= band]
            src = near if len(near) >= 3 else pool
            # Two-stage hierarchy: the price-implied figure is the PRIOR the
            # player's own history is shrunk toward, not a replacement for it.
            # w = career_n90 / (career_n90 + K) — the same credibility shape
            # used everywhere else in the model, so a player with no PL record
            # still lands on the price proxy exactly as before (w = 0), while
            # one with a real career keeps most of what he actually did.
            w = float(career.loc[i] / (career.loc[i] + career_k)) \
                if (career.loc[i] + career_k) > 0 else 0.0
            for c in cols:
                if c in df.columns:
                    implied = float(src[c].median()) * damping
                    own = pd.to_numeric(pd.Series([df.at[i, c]]),
                                        errors="coerce").iloc[0]
                    if w > 0 and pd.notna(own):
                        df.at[i, c] = w * float(own) + (1 - w) * implied
                    else:
                        df.at[i, c] = implied

    # Flag only the players the proxy actually dominates. A player who kept
    # most of his own record is not running on a price-derived rate, and
    # labelling him as such in the UI would be false.
    df["price_implied_prior"] = needs
    df["price_implied_w"] = np.where(
        needs, 1.0 - (career / (career + career_k)).to_numpy(), 0.0)
    df["rate_mostly_price"] = needs & (df["price_implied_w"] > 0.5)
    return df


def attach(players: pd.DataFrame, congested_teams: set[str] | None = None) -> pd.DataFrame:
    congested_teams = congested_teams or set()
    recs = []
    for _, p in players.iterrows():
        est = estimate(p,
                       prior_mins_share=p.get("mins_share_prior"),
                       congested=p["team"] in congested_teams)
        recs.append(est)
    est_df = pd.DataFrame(recs, index=players.index)
    return pd.concat([players, est_df], axis=1)
