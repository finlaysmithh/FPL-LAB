"""
Multi-season player production rates — reversion to the mean, measured.

The model rated every player on ONE prior season. For a player who was fit and
first-choice all year that is fine. For anyone whose season was interrupted it
is badly wrong, because a small, unlucky sample gets treated as the player's
true level:

    xG per 90            2023-24   2024-25   2025-26
    Alexander Isak         0.808     0.663     0.336   <- 7.7 full games
    Mohamed Salah          0.743     0.659     0.345
    Bukayo Saka            0.474     0.359     0.307
    Erling Haaland         1.042     0.720     0.777

Isak's 0.336 rests on seven and a half matches of an injury-wrecked season.
Projecting next season off it says he has become a different player, which is
not what the evidence says — it is what a small sample says.

The fix is a credibility-weighted blend across seasons, where each season's
weight is `decay^(seasons ago) x n90`. Weighting by SAMPLE as well as recency
is the part that matters: it is what makes Isak's 30-game season outrank his
7-game one automatically, without anyone deciding that his last season was
"the injured one". Haaland, who played 28-33 games every year, is barely moved
because his recent seasons already carry the most weight.

Validated out of sample, predicting each season's rate from the seasons before
it, on players with 10+ full matches in the target year:

                       xG90 MAE            xA90 MAE
    target      blend / last-season   blend / last-season
    2024-25     0.0480 / 0.0552       0.0293 / 0.0321
    2025-26     0.0456 / 0.0514       0.0316 / 0.0334

Better on both metrics in both years, by 6-13%. This is a real improvement,
not a plausible one.

WHAT IS NOT BLENDED
-------------------
Minutes. Production per 90 is a player's skill and it persists; the size of his
role is a fact about his current club and changes the moment he is transferred
or a new manager arrives. Blending three seasons of minutes would have half of
Isak's role still sitting at Newcastle. Minutes stay on the latest season's
availability-adjusted share plus the predicted XI — see fplab/fit_minutes.py.

DECAY
-----
0.70 per season. The two holdout years disagree about the optimum (2024-25
prefers 0.55, 2025-26 prefers 1.0), which is the signal that neither optimum is
real; 0.70 sits between them and is within 0.001 MAE of the best value in both.
Picking either year's winner would be fitting the fold, not the effect.

WHAT IS CARRIED: THE SHARE, NOT THE RATE
----------------------------------------
A per-90 rate is not a property of the player alone — it is the product of how
good he is at getting into chances and how many chances his club creates. Carry
the raw rate across a transfer and the two halves get mismatched, because the
engine's next step (`xpts.player_xp`) divides the carried rate by the player's
CURRENT club's xG90 to recover a share:

    striker, 0.50 xG90 at a 1.2-xG90 club   ->  he owned 42% of the chances
    moves to a 1.9-xG90 club
    0.50 / 1.9                              ->  reads as 26%

The move made him look a third worse at the exact moment he joined a better
side. So the carried quantity is the SHARE, measured against the club he was
actually at when he earned it (minutes-weighted, so a January transfer is split
between both clubs), and the current club's creation is applied once, at the
end, in `blend.build_player_rates`:

    share_s   = xg90_s / team_xg90(his club that season)
    share     = credibility-weighted blend of share_s across seasons
    share     = shrink(share, toward the positional mean, by minutes)
    xg90_prior = share * team_xg90(his club NOW)

Shrinkage toward the positional mean is what stops a share estimated on a
half-season being multiplied straight into a big club's lambda. Same shape as
everywhere else in this codebase: w = n90 / (n90 + SHARE_SHRINK_K).

Measured out of sample — predict each season's rate from the season before it,
players with 3+ full matches in both. MAE, carrying the rate vs carrying the
shrunk share:

    fold          metric   players who CHANGED CLUB     all players
                           rate      share (K=10)    rate      share
    22-23->23-24  xG90     0.0968 -> 0.0894          0.0784 -> 0.0611
                  xA90     0.0641 -> 0.0449          0.0513 -> 0.0367
    23-24->24-25  xG90     0.0867 -> 0.0647          0.0621 -> 0.0535
                  xA90     0.0297 -> 0.0283          0.0332 -> 0.0312
    24-25->25-26  xG90     0.0975 -> 0.0710          0.0543 -> 0.0461
                  xA90     0.0433 -> 0.0412          0.0355 -> 0.0314

Better in all six folds, by 5-30%, and the gain is largest exactly where the
argument says it should be — the movers. The top-30 xG90 players improve too
(e.g. 0.1666 -> 0.1069 in 23-24->24-25), so this is not the usual trade where
the middle of the distribution pays for the top.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .sources import DATA

# Oldest first. Four seasons is where the data runs out for expected goals.
SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"]

SEASON_DECAY = 0.70

# Minimum full matches in a season for it to contribute at all. Below three,
# a rate is one good afternoon divided by a rounding error.
MIN_N90 = 3.0

# Credibility constant for how much the older seasons are still needed once a
# recent season exists, in full matches: need = K / (n_recent + K).
#
# Out of sample, against last-season-only (xG90 / xA90 MAE):
#
#     target      last only        K=10           K=30
#     2024-25   0.0510 / 0.0314  0.0466 / 0.0290  0.0453 / 0.0287
#     2025-26   0.0500 / 0.0337  0.0452 / 0.0314  0.0442 / 0.0310
#
# MAE keeps improving up to K = 30 and beyond, and 10 ships anyway. That is a
# deliberate trade, not an oversight, and the reason is what the average hides.
# A large K reverts EVERYONE heavily, including players whose recent season was
# their best on a full sample — Bruno Fernandes has improved four years running
# (points per game 4.78, 4.79, 5.19, 6.90 on 33-37 matches a year) and K = 30
# drags him back toward a level he has demonstrably outgrown. The MAE gain
# comes from the many mediocre players in the middle, and it is paid for by the
# handful at the top that Fantasy decisions actually turn on.
#
# K = 10 lets SAMPLE SIZE do the work, which is the honest signal:
#
#     player     recent n90    reversion weight
#     Isak           7.7           0.57      wrecked season, revert hard
#     Palmer        21.7           0.32      interrupted, revert some
#     Saka          24.6           0.29      interrupted, revert some
#     Bruno         34.1           0.23      full season, trust it
#
# That ordering is the whole point: a bad year on a small sample is noise, and
# a good year on a full sample is information.
REVERSION_K = 10.0

# Credibility constant for shrinking a player's CHANCE SHARE toward his
# positional mean, in full matches: w = n90 / (n90 + K).
#
# Unshrunk shares (K = 0) are already better than carrying raw rates in four of
# the six holdout folds, but worse in two — a share measured over a handful of
# matches is a noisy ratio, and multiplying it straight into a big club's
# lambda amplifies that noise rather than damping it. Any K in 10-40 fixes it
# and wins every fold. Larger values keep nudging the AVERAGE down (xA90 on
# 24-25->25-26: 0.0412 at K=10, 0.0384 at K=40) for the same reason discussed
# under REVERSION_K above — heavy reversion flatters the mediocre middle and
# quietly flattens the players Fantasy decisions actually turn on. K = 10 is
# the smallest value that wins everywhere, it is best or within 0.001 of best
# on every fold including the top-30 subset, and it matches REVERSION_K, so the
# module has one credibility scale rather than two.
SHARE_SHRINK_K = 10.0

# Fallback team creation when a club cannot be resolved: the league mean of
# ~1.45 xG per team per match that `config.LEAGUE_AVG_GOALS_PER_TEAM` carries.
LEAGUE_TEAM_XG90 = 1.45

# Rates carried as a share of team creation rather than as a raw per-90. Both
# are divided by the team's xG90 in `xpts.player_xp` — assists included, since
# a chance created is a chance the team took.
SHARE_COLS = {"xg90": "xg_share", "xa90": "xa_share"}

# How much of the rate reversion weight applies to MINUTES. Roles reset on a
# transfer in a way that finishing does not, so older seasons say less about a
# player's current role than about his current ability.
MINUTES_REVERSION = 0.5

# Rates that are player skill and therefore worth blending across seasons.
# `defensive_contribution` only exists from 2025/26, so it contributes from the
# seasons that have it and is simply absent from the others — the weights
# renormalise, they do not silently treat a missing column as zero.
RATE_COLS = {
    "xg90": "expected_goals",
    "xa90": "expected_assists",
    "bps90": "bps",
    "defcon90": "defensive_contribution",
    "cbi90": "clearances_blocks_interceptions",
    "saves90": "saves",
    "yellow90": "yellow_cards",
    "red90": "red_cards",
}


def _team_xg90(g: pd.DataFrame) -> pd.Series:
    """
    Team xG per match for one season, keyed by the `team` label as it appears
    in that season's merged_gw — which is what the player rows are keyed on
    too, so no cross-season club-name mapping is needed. Summing player xG over
    a fixture recovers the team's xG for that match (see
    `build_prior.team_match_log`, which does the same thing for the ratings).
    """
    per_match = g.groupby(["fixture", "team"])["expected_goals"].sum()
    return per_match.groupby("team").mean()


def _season_rates(season: str) -> pd.DataFrame | None:
    """
    Per-player season rates keyed on FPL's cross-season `code`.

    Also returns the CLUB CONTEXT the player earned those rates in — the
    minutes-weighted team xG90 across every club he turned out for that season,
    so a January transfer is split between the two rather than being credited
    wholly to whichever club he finished at — and his share of it.
    """
    base = DATA / f"vaastav_{season}"
    gw_path = base / "gws" / "merged_gw.csv"
    raw_path = base / "players_raw.csv"
    if not gw_path.exists() or not raw_path.exists():
        return None

    g = pd.read_csv(gw_path)
    raw = pd.read_csv(raw_path)
    if "code" not in raw.columns:
        return None
    g["code"] = g["element"].map(dict(zip(raw["id"], raw["code"])))
    g = g[g["code"].notna()]

    have = {k: c for k, c in RATE_COLS.items() if c in g.columns}
    agg = g.groupby("code").agg(
        minutes=("minutes", "sum"),
        **{k: (c, "sum") for k, c in have.items()},
    ).reset_index()
    agg["n90"] = agg["minutes"] / 90.0
    agg = agg[agg["n90"] >= MIN_N90].copy()
    for k in have:
        agg[k] = agg[k] / agg["n90"]
    # Columns the season genuinely does not carry stay NaN so they contribute
    # no weight, rather than dragging a real average toward zero.
    for k in RATE_COLS:
        if k not in agg.columns:
            agg[k] = np.nan

    # ---- club context, minutes-weighted across the clubs he played for -----
    txg = _team_xg90(g)
    by_club = g.groupby(["code", "team"])["minutes"].sum().reset_index()
    by_club = by_club[by_club["minutes"] > 0]
    by_club["txg"] = by_club["team"].map(txg)
    by_club = by_club[by_club["txg"].notna()]
    num = (by_club["minutes"] * by_club["txg"]).groupby(by_club["code"]).sum()
    den = by_club["minutes"].groupby(by_club["code"]).sum()
    agg["team_xg90"] = agg["code"].map(num / den).fillna(LEAGUE_TEAM_XG90)
    # The club he played the most minutes for — reporting only; the share above
    # already accounts for both halves of a mid-season move.
    agg["club"] = agg["code"].map(
        by_club.sort_values("minutes").groupby("code")["team"].last())

    for rate, share in SHARE_COLS.items():
        agg[share] = agg[rate] / agg["team_xg90"].replace(0.0, np.nan)

    agg["position"] = agg["code"].map(
        dict(zip(raw["code"], raw["element_type"].map(
            {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}))))
    agg["season"] = season
    return agg[["code", "season", "n90", "team_xg90", "club", "position",
                *RATE_COLS.keys(), *SHARE_COLS.values()]]


def blended_rates(seasons: list[str] | None = None,
                  decay: float = SEASON_DECAY) -> pd.DataFrame:
    """
    Credibility-weighted rates per player across seasons.

    Returns one row per `code` with each rate column, the total weight behind
    it (`hist_n90`, in full matches, decayed) and `hist_seasons`.
    """
    seasons = seasons or SEASONS
    frames = [f for f in (_season_rates(s) for s in seasons) if f is not None]
    if not frames:
        return pd.DataFrame(columns=["code", "hist_n90", "hist_seasons",
                                     *RATE_COLS.keys()])
    df = pd.concat(frames, ignore_index=True)

    order = {s: i for i, s in enumerate(seasons)}
    ago = (len(seasons) - 1) - df["season"].map(order)

    # Older seasons FILL A CREDIBILITY GAP; they do not compete with a full
    # recent sample. This is the difference between reversion to the mean and
    # simply averaging a career.
    #
    # Bruno Fernandes is the case that forced it. His xG90 ran 0.200, 0.281,
    # 0.296, 0.317 and his points per game 4.78, 4.79, 5.19, 6.90 — improving
    # every year, on 33-37 full matches every year. A fixed decay weights those
    # four near-equal samples 1.00 / 0.70 / 0.49 / 0.34, so the most recent
    # season carries only 40% and three progressively worse ones drag an
    # improving player back toward a level he has outgrown. That is not
    # reversion to the mean, it is refusing to believe the mean has moved.
    #
    # So the recent season is taken at full weight, and older seasons share
    # only the credibility it does not already supply:
    #
    #     need = REVERSION_K / (n90_recent + REVERSION_K)
    #
    # Bruno, on 34 recent matches, leans mostly on his current level. Isak, on
    # 7.7, leans mostly on the 30-game seasons either side of it. And an elite
    # player who had a flat year on full minutes — Saka, Palmer — is pulled
    # part of the way back toward the level he established, because one
    # ordinary season is not enough evidence that a good player has stopped
    # being good.
    recent = seasons[-1]
    n_recent = (df[df["season"] == recent].set_index("code")["n90"]
                .reindex(df["code"]).fillna(0.0).to_numpy())
    need = REVERSION_K / (n_recent + REVERSION_K)
    is_recent = (df["season"] == recent).to_numpy()
    df["w"] = np.where(is_recent,
                       df["n90"].to_numpy(),
                       (decay ** ago) * df["n90"].to_numpy() * need)

    out = {}
    for k in (*RATE_COLS, *SHARE_COLS.values(), "team_xg90"):
        v = df[k]
        w = df["w"].where(v.notna(), 0.0)
        num = (w * v.fillna(0.0)).groupby(df["code"]).sum()
        den = w.groupby(df["code"]).sum()
        out[k] = num / den.replace(0.0, np.nan)

    res = pd.DataFrame(out)

    # ---- shrink the carried share toward the positional mean ---------------
    # The share is a ratio, and a ratio measured over a handful of matches is
    # noisy in a way the rate it came from is not — dividing by a club's
    # creation does not add evidence, it just re-expresses it. Downstream that
    # share gets multiplied by the CURRENT club's lambda, so an unshrunk share
    # off a short sample is noise amplified by a big club rather than damped.
    # Shrinking by the same n90/(n90+K) credibility used everywhere else keeps
    # a full-season share almost intact (0.77 of it at 34 matches) while a
    # seven-match share lands mostly on his position's mean.
    #
    # The mean is weighted by evidence and taken over the players who have
    # enough of it, so it describes what a typical starting midfielder's share
    # of his club's chances looks like, not what the deepest squad player does.
    pos = (df.sort_values("season").groupby("code")["position"].last())
    res["position"] = pos.reindex(res.index)
    res["career_n90"] = df.groupby("code")["n90"].sum()

    # DefCon and BPS get the same treatment as the shares, and did not used to.
    # They are per-90 RATES, so a player with fifteen matches on record carried
    # his raw figure straight into the projection while a chance share measured
    # on the same fifteen matches was shrunk. That inconsistency systematically
    # flattered small-sample players: Canvot's 11.43 DefCon90 rests on about
    # fifteen full matches and outranks a defender with five seasons behind him.
    for col in [*SHARE_COLS.values(), "defcon90", "bps90"]:
        if col not in res.columns:
            continue
        v, n = res[col], res["career_n90"].fillna(0.0)
        solid = v.notna() & (n >= MIN_N90)
        pos_mean = (v.where(solid) * n.where(solid)).groupby(res["position"]).sum() \
            / n.where(solid & v.notna()).groupby(res["position"]).sum()
        prior = res["position"].map(pos_mean)
        # A position with no measurable population falls back to the league
        # picture rather than to zero, which would erase the player.
        prior = prior.fillna(v[solid].mean() if solid.any() else 0.0)
        w = n / (n + SHARE_SHRINK_K)
        res[f"{col}_raw"] = v
        res[col] = w * v.fillna(prior) + (1 - w) * prior

    # Minutes share, blended on the SAME credibility logic as the rates.
    # Production per 90 and size of role are different quantities, and role is
    # the more volatile of the two — but a role measured over 24 matches of an
    # injury-hit season is still a partial measurement, and treating it as
    # complete is what left Saka, Arsenal's first-choice winger, allocated 31
    # minutes a game. The blend is deliberately weaker than for rates (half the
    # reversion weight) because a transfer or a new manager really does reset a
    # role in a way it does not reset a player's finishing.
    share = df["n90"] / 38.0
    ws = df["w"].where(df["season"] == seasons[-1], df["w"] * MINUTES_REVERSION)
    res["mins_share_hist"] = ((ws * share).groupby(df["code"]).sum()
                              / ws.groupby(df["code"]).sum().replace(0.0, np.nan))
    res["hist_n90"] = df.groupby("code")["w"].sum()
    res["hist_seasons"] = df.groupby("code")["season"].nunique()
    # `career_n90` — raw, undecayed career minutes — is set above, before the
    # share shrinkage, because it is the evidence count that shrinkage runs on.
    # Club trail, oldest first: what the share was actually earned at, and the
    # basis for the club-change report.
    trail = df.sort_values("season").groupby("code")["club"]
    res["hist_clubs"] = trail.apply(lambda s: " -> ".join(pd.unique(s.dropna())))
    res["hist_last_club"] = trail.last()
    res["hist_n_clubs"] = trail.nunique()
    return res.reset_index()


def club_change_report(seasons: list[str] | None = None,
                       lookback: int = 3) -> pd.DataFrame:
    """
    Every player who changed clubs within the last `lookback` seasons, with the
    prior he would have been given under each treatment.

    `rate_carry` is what the model used to hand `blend`: the raw multi-season
    per-90, which `xpts` then divided by the CURRENT club's creation.
    `share_carry` is what it hands over now: the shrunk share restated against
    that same club. The difference is the whole point of the change, so it is
    reported per player rather than asserted in aggregate.
    """
    seasons = seasons or SEASONS
    window = seasons[-(lookback + 1):]      # N moves need N+1 seasons of clubs
    frames = [f for f in (_season_rates(s) for s in window) if f is not None]
    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True).sort_values(["code", "season"])

    trail = df.groupby("code")["club"]
    movers = trail.nunique()
    movers = movers[movers > 1].index

    hist = blended_rates(seasons).set_index("code")
    latest = df.sort_values("season").groupby("code").last()

    rows = []
    for code in movers:
        if code not in hist.index:
            continue
        h, cur = hist.loc[code], latest.loc[code]
        # The club he is at now, and its creation. Pre-season this is his
        # last-played club; once the live build runs, `blend` uses the real
        # current club and this report is the same arithmetic on that value.
        now_xg = float(cur["team_xg90"])
        rows.append({
            "code": int(code),
            "clubs": " -> ".join(pd.unique(df[df["code"] == code]["club"].dropna())),
            "position": h.get("position"),
            "n90": round(float(h["career_n90"]), 1),
            "old_ctx_xg90": round(float(h["team_xg90"]), 2),
            "new_ctx_xg90": round(now_xg, 2),
            "rate_carry_xg90": round(float(h["xg90"]), 3),
            "share_carry_xg90": round(float(h["xg_share"]) * now_xg, 3),
            "rate_carry_xa90": round(float(h["xa90"]), 3),
            "share_carry_xa90": round(float(h["xa_share"]) * now_xg, 3),
        })
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["d_xg90"] = (out["share_carry_xg90"] - out["rate_carry_xg90"]).round(3)
    out["d_xa90"] = (out["share_carry_xa90"] - out["rate_carry_xa90"]).round(3)
    return out.sort_values("d_xg90", ascending=False).reset_index(drop=True)


def print_club_change_report(lookback: int = 3) -> pd.DataFrame:
    rep = club_change_report(lookback=lookback)
    if rep.empty:
        print("no club changes found in the window")
        return rep
    names = {}
    for s in reversed(SEASONS):
        raw_path = DATA / f"vaastav_{s}" / "players_raw.csv"
        if raw_path.exists():
            raw = pd.read_csv(raw_path)
            for c, n in zip(raw["code"], raw["web_name"]):
                names.setdefault(int(c), n)
    rep.insert(1, "name", rep["code"].map(names).fillna("?"))
    cols = ["name", "position", "clubs", "n90", "old_ctx_xg90", "new_ctx_xg90",
            "rate_carry_xg90", "share_carry_xg90", "d_xg90",
            "rate_carry_xa90", "share_carry_xa90", "d_xa90"]
    print(f"\n{len(rep)} players changed clubs in the last {lookback} seasons "
          f"({SEASONS[-(lookback + 1)]} -> {SEASONS[-1]})")
    print("rate_carry = old prior (raw per-90); share_carry = new prior "
          "(share x current club xG90)\n")
    print(rep[cols].to_string(index=False))
    up = (rep["d_xg90"] > 0.01).sum()
    dn = (rep["d_xg90"] < -0.01).sum()
    print(f"\n{up} players revised UP on xG90, {dn} revised DOWN, "
          f"{len(rep) - up - dn} effectively unchanged; "
          f"largest move {rep['d_xg90'].abs().max():+.3f} xG90")
    return rep


def main() -> None:
    import sys
    if "--moves" in sys.argv:
        print_club_change_report()
        return
    r = blended_rates()
    r.to_parquet(DATA / "player_history.parquet", index=False)
    print(f"blended {len(r)} players across {len(SEASONS)} seasons "
          f"(decay {SEASON_DECAY})")
    print(f"  {int((r.hist_seasons >= 3).sum())} with 3+ seasons, "
          f"{int((r.hist_seasons == 1).sum())} with only one")

    # The cases this exists for.
    raw = pd.read_csv(DATA / "vaastav_2025-26" / "players_raw.csv")
    nm = dict(zip(raw["code"], raw["web_name"]))
    last = _season_rates("2025-26").set_index("code")
    show = r[r["code"].isin(nm)].copy()
    show["name"] = show["code"].map(nm)
    show["last_xg90"] = show["code"].map(last["xg90"])
    show["moved"] = show["xg90"] - show["last_xg90"]
    big = show.reindex(show["moved"].abs().sort_values(ascending=False).index)
    print("\nlargest reversions (blended xG90 vs last season alone):")
    print(big.head(12)[["name", "last_xg90", "xg90", "hist_seasons"]]
          .round(3).to_string(index=False))


if __name__ == "__main__":
    main()
