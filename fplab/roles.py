"""
Squad minute allocation: conservation and depth.

A football team plays exactly eleven players at a time. That is the hardest
constraint in the whole game and until now the model ignored it entirely —
every player was estimated on his own, from his own history and his own price,
and nothing ever checked that the twenty-odd estimates for a club added up to a
football team.

They did not. Measured on the shipped 2026/27 projections, expected outfield
minutes per match by club:

    HUL   666   (0.72x)        CHE  1490   (1.62x)
    IPS   787   (0.85x)        TOT  1396   (1.51x)
    COV   787   (0.85x)        MCI  1304   (1.41x)

against a real, measured budget of 921.8. Hull were fielding seven and a half
men and Chelsea sixteen.

The direction of the error is not random, and it explains a specific complaint
about the model. A promoted club's entire squad has no Premier League record,
so every one of them falls to a price-implied floor — but *someone* has to play
for Ipswich, and the model had no way to know that. It is why Dara O'Shea, a
nailed Championship-winning centre-half, was projected for 25 minutes a game
and why a squad full of promoted-club enablers totalled in the fifties. The
mirror image happens at clubs with thirty-four registered players, where the
model quietly fielded half a team too many.

Water-filling
-------------
Each player carries a role score `r` — his unconstrained expected minutes, the
number the rest of the pipeline already produces — and a per-gameweek
availability `a` in [0, 1]. Expected minutes are

    m_i = a_i * min(90, lambda * r_i)

with a single `lambda` per club per gameweek chosen so the m_i sum to the
budget. This is the standard water-filling solution to "distribute a fixed
quantity in proportion to demand, subject to a per-unit cap", and it has the
three properties needed here:

* **Rank-preserving.** min(90, lambda*r) is monotone in r, so the model's view
  of who is better than whom is never disturbed — only the level moves.
* **Self-correcting on depth.** A club whose squad is under-rated in aggregate
  gets lambda > 1 and everyone rises; a bloated squad gets lambda < 1.
* **Injuries reallocate automatically.** This is the part that matters most.
  When Saliba and Timber are unavailable their `a` is 0, their minutes leave
  the sum, and lambda rises until the remaining defenders absorb them. Nobody
  has to hand-maintain a depth chart per club: the constraint does it, for all
  twenty clubs, every gameweek, from the injury flags the model already holds.

Goalkeepers are allocated separately against their own 92.7-minute budget,
because a keeper is not interchangeable with an outfielder and the position is
close to winner-take-all — the measured rank profile is 76.7 minutes for the
first choice and 14.5 for everyone else combined.

What this does not do
---------------------
It does not know about players outside the FPL dataset. A club reduced to nine
available registered players will have its remaining nine inflated rather than
the model inventing an academy full-back, so `LAMBDA_MAX` caps how far the
reallocation can run and `allocate` reports the shortfall instead of hiding it.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .sources import DATA

# Measured over 80 club-seasons, 2022-23 → 2025-26. Ten outfielders for ninety
# minutes is 900 by arithmetic; FPL credits stoppage time to whoever is on the
# pitch and a full minute to a 90th-minute substitute, so the real book runs a
# little above that. Using the measured figure rather than the arithmetic one
# is worth ~2% on every projection.
BUDGET_OUTFIELD = 921.8
BUDGET_GK = 92.7

# The most a club's players may be inflated to cover absences. At 3.0 a side
# missing two thirds of its registered squad still balances; beyond that the
# honest answer is that the model does not know who is playing.
LAMBDA_MAX = 3.0
LAMBDA_MIN = 0.15

MAX_MINUTES = 90.0

# Outfield players a club can field at once. The measured-record floor is
# applied to this many per club and no more — eleven shirts, eleven claims.
XI_SLOTS_OUTFIELD = 11

# Squad concentration exponent, applied to the minutes share before the budget
# is imposed: role' = 90 * (role/90) ** ROLE_CONCENTRATION.
#
# Conservation alone is not enough, and shipping it alone would have been a
# regression. Scaling a club's estimates to fit the budget assumes the SHAPE of
# those estimates is right and only the level is wrong. It was not. The model's
# unconstrained rank profile across a squad ran
#
#     64  61  59  57  53  50  48  46  44  42  41  39  37  36  34  31  29  27
#
# against a measured reality of
#
#     86  81  75  71  66  62  58  54  50  47  42  37  33  29  26  23  20  16
#
# — far too flat, because every estimate is drawn toward a price-band median
# and nothing pulls the ends apart. Imposing the budget on that shape takes
# minutes from a nailed striker to fund a fourth-choice full-back: Haaland fell
# from 73 expected minutes to 52 on the first attempt, which is how this was
# caught.
#
# A single power transform is rank-preserving — it never reorders a club's
# players, it only stretches the gaps between them.
#
# Fitted against the real profile on the 17 ESTABLISHED clubs, which is the
# only place the test is meaningful: at a promoted club the model has no
# information to rank anyone, so its flat allocation there is correct-given-
# ignorance and including those three would be scoring the fit on a question it
# is not being asked. The resulting profile:
#
#   rank        1     2     3     4     5     6     7     8     9    10    11
#   real     86.2  81.0  75.4  70.7  66.0  62.4  58.0  53.8  50.1  46.5  41.6
#   model    82.0  78.2  75.4  71.8  68.8  66.7  63.6  60.6  57.9  54.6  43.3
#
# 2.0 is chosen over the RMSE-optimal 1.6 (4.41 against 4.06) because the
# difference between them is entirely in ranks 15-18 — players nobody owns —
# while 2.0 tracks ranks 11-13, the marginal starters an FPL manager actually
# has to decide about, more closely.
#
# Note how little the top ten move with the exponent. They are set by the
# evidence-based floor in `allocate`, not by this constant: measurement governs
# the first team and the prior only shapes the fringe, which is the correct
# division of labour and a good sign the two mechanisms are not fighting.
#
# The model's rank 1 sits ~4 minutes below reality and should. The real rank-1
# figure is a survivor: it belongs to whichever player happened to stay fit all
# season. Ex ante nobody is guaranteed to be that player, so a forecast that
# reproduced 86.2 exactly would be overconfident rather than accurate.
#
# It is applied to how often a player is PICKED, never to how long he lasts —
# see `allocate`. That distinction is not cosmetic: squeezing the raw minutes
# share instead cost Haaland 21 expected minutes a game for the crime of being
# substituted on 80 minutes, which is a fact about how Guardiola uses him and
# not a statement about whether he is in the team.
ROLE_CONCENTRATION = 2.00

# Floor on the pick probability of a player named in a predicted starting XI.
#
# Measured, not asserted: across the 20 clubs of 2025/26, the eleven outfielders
# who played the most minutes for each club started 74.2% of the matches they
# were available for (median 75.8%), and each club's first-choice goalkeeper
# started 94.2%. Goalkeeping is close to winner-take-all and outfield selection
# is not, which is why one number would not do for both.
#
# This floor applies to EVERY named starter, not only the ones the model knows
# nothing about. Being picked is information about a manager's intentions and
# it is just as relevant to Haaland as to a promoted-club centre-half — more so,
# in fact, because a thirty-man squad is exactly where conservation would
# otherwise dilute a guaranteed starter to fund nine rotation forwards. Without
# this floor Haaland came out at 59 expected minutes, behind several Man City
# players who are not certain to be picked at all.
# How much being named in a predicted XI is worth as a TIEBREAK, on the same
# 0-1 scale as a pick rate. Small on purpose: it separates two players the
# model rates equally, and cannot promote a guess over a measured record.
XI_NAME_TIEBREAK = 0.03

XI_NAIL_FLOOR = 0.742
XI_NAIL_FLOOR_GK = 0.942

# Outfield minutes per team per match by position, measured over 2023-24 to
# 2025-26: DEF 369.8, MID 426.8, FWD 98.4 (GK is 90.0 by construction). Held
# as SHARES so they scale with `budget_outfield` rather than fighting it.
POS_BUDGET_SHARE = {"DEF": 0.4132, "MID": 0.4768, "FWD": 0.1100}
# Starting shirts by position, from the same split: 10 outfield slots divided
# 4 / 5 / 1. This is the count the floor logic hands out per club-position.
POS_XI_SLOTS = {"DEF": 4, "MID": 5, "FWD": 1}


# Prior-season minutes above which a player's own pick rate is treated as
# measured rather than inferred. Deliberately the same 900 the minutes guard
# uses to decide the same thing, because two different answers to one question
# inside one pipeline is how a model drifts apart from itself.
EVIDENCE_MINUTES = 900.0


def _has_record(minutes: pd.Series | None, index) -> pd.Series:
    """Players with enough Premier League minutes to have a measured role."""
    if minutes is None:
        return pd.Series(False, index=index)
    m = pd.to_numeric(minutes, errors="coerce").reindex(index).fillna(0.0)
    return m >= EVIDENCE_MINUTES


def _evidence_weight(minutes: pd.Series | None, index) -> np.ndarray:
    """w = m / (m + K): 0 for an unseen player, ~0.77 at a full season."""
    if minutes is None:
        return np.zeros(len(index))
    m = pd.to_numeric(minutes, errors="coerce").reindex(index).fillna(0.0)
    return (m / (m + EVIDENCE_MINUTES)).to_numpy()


def _picked(lam: float, nail: np.ndarray, floor: np.ndarray) -> np.ndarray:
    """Pick probability at a given scaling, respecting the per-player floor."""
    return np.clip(lam * nail, floor, 1.0)


def _solve_lambda(nail: np.ndarray, cap: np.ndarray, avail: np.ndarray,
                  budget: float, floor: np.ndarray) -> float:
    """Smallest lambda with sum(a * cap * clip(lambda*nail, floor, 1)) == budget.

    The total is continuous, non-decreasing and piecewise linear in lambda, so
    a bisection is exact to tolerance and cannot get stuck — worth preferring
    over a closed form, which would need the breakpoints sorted and special
    cases for ties.

    The floor is inside the objective rather than applied to the result, and
    that is the whole point. Flooring a named starter's pick probability first
    and then scaling the club to its budget destroys the floor at exactly the
    clubs it exists for: Manchester City's thirty registered players scale by
    lambda ~= 0.75, which took Haaland's floored 0.742 straight back down to
    0.56. Solving with the floor in place makes the rest of the squad absorb
    the adjustment instead, which is what a squad with one certain starter and
    nine rotation forwards actually looks like.
    """
    live = avail > 0
    if not live.any() or nail[live].sum() <= 0:
        return 1.0
    if float((avail * cap).sum()) <= budget:
        return LAMBDA_MAX                      # cannot reach it; go as far as allowed

    def total(lam: float) -> float:
        return float((avail * cap * _picked(lam, nail, floor)).sum())

    lo, hi = LAMBDA_MIN, LAMBDA_MAX
    if total(lo) >= budget:
        return lo
    if total(hi) <= budget:
        return hi
    for _ in range(60):
        mid = (lo + hi) / 2
        if total(mid) < budget:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def allocate(
    role_score: pd.Series,
    team: pd.Series,
    position: pd.Series,
    avail: pd.Series | None = None,
    mins_per_start: pd.Series | None = None,
    predicted_xi: pd.Series | None = None,
    xi_floor_weight: float = 1.0,
    evidence_minutes: pd.Series | None = None,
    budget_outfield: float = BUDGET_OUTFIELD,
    budget_gk: float = BUDGET_GK,
    concentration: float = ROLE_CONCENTRATION,
    positional_budget: bool = True,
) -> pd.DataFrame:
    """
    Redistribute expected minutes so every club fields a legal team.

    `role_score` is unconstrained expected minutes per match; `mins_per_start`
    is how long the player lasts in a match he starts, which acts as his
    personal ceiling in place of a flat 90.

    Returns a frame indexed like the inputs with:
        exp_mins     allocated expected minutes per match
        mins_share   exp_mins / 90
        nailed       P(the club picks him), before availability
        role_lambda  the club-and-position scaling that was applied
        role_shortfall  True where the squad could not cover its budget
    """
    r = pd.to_numeric(role_score, errors="coerce").fillna(0.0).clip(lower=0.0)
    if mins_per_start is None:
        cap = pd.Series(MAX_MINUTES, index=r.index, dtype=float)
    else:
        cap = pd.to_numeric(mins_per_start, errors="coerce").fillna(
            MAX_MINUTES).clip(45.0, MAX_MINUTES)

    # Split the role score into "how often is he picked" and "how long does he
    # last", and concentrate only the first. Squeezing the raw minutes share
    # instead punishes a nailed striker for being substituted on 80 minutes,
    # which is not a statement about his place in the team. See
    # ROLE_CONCENTRATION.
    raw_nail = (r / cap).clip(0.0, 1.0)
    nailed = raw_nail.copy()
    if concentration and concentration != 1.0:
        # The exponent fades as real evidence accumulates. Concentration exists
        # to pull apart estimates that are bunched around a price-band median
        # because the model has never seen these players; it has no business
        # reshaping a pick rate that has actually been observed.
        #
        # This is not a nicety — the walk-forward backtest measures it. Applied
        # flat at 2.0 mid-season, where `minutes.estimate` already has real
        # start rates, it costs MAE outright:
        #
        #     2024-25   no conservation 1.843 | flat 2.0  1.954 | at 1.0  1.819
        #     2025-26   no conservation 1.987 | flat 2.0  2.086 | at 1.0  1.979
        #
        # Fading it recovers the 1.0 column for observed players while leaving
        # the pre-season shape intact, because pre-season every player has zero
        # current-season minutes and the weight is zero by construction.
        w = _evidence_weight(evidence_minutes, r.index)
        nailed = np.power(nailed, 1.0 + (concentration - 1.0) * (1.0 - w))

    is_gk_all = position.astype(str).str.upper().eq("GK")
    nail_floor = pd.Series(0.0, index=r.index, dtype=float)

    # A player's OWN measured record floors him, named in a predicted XI or
    # not. This is the important half, and leaving it out did real damage:
    # because the floor consumed a club's minute budget, naming eleven players
    # did not merely lift them, it CAPPED everyone else. Declan Rice, on 3,093
    # minutes and a 0.89 share, came out at a 45% chance of starting purely
    # because a pre-season line-up prediction had eleven other Arsenal names on
    # it. Saka came out at 33%.
    #
    # A predicted XI is a guess about a team sheet. Three thousand minutes is
    # evidence. The guess is allowed to inform players the model knows nothing
    # about; it is not allowed to demote players it knows a great deal about.
    measured = _has_record(evidence_minutes, r.index)

    if predicted_xi is not None:
        # The floor applies ONLY to named players the model cannot rank for
        # itself. That is the file's entire purpose and the scope it should
        # always have had.
        #
        # Two failures got it here. Flooring only NAMED players meant the floor
        # consumed the club's minute budget, so naming eleven Arsenal players
        # capped everyone else: Declan Rice, on 3,093 minutes, came out at a
        # 45% chance of starting, and Saka at 33%. Flooring EVERY measured
        # player fixed that and broke something worse — a registered squad
        # contains fifteen-plus players with real records, their floors
        # massively over-subscribe eleven shirts, and scaling them back to fit
        # dragged the whole league down (Haaland 6.38 to 5.36 a game).
        #
        # The resolution is that a measured player does not need a floor at
        # all. Water-filling already allocates him in proportion to his own
        # record, and it does so without claiming a fixed slice of a budget
        # that eleven other players are also claiming. Only players with no
        # record need to be told they are in the team.
        named = predicted_xi.reindex(r.index).fillna(False).astype(bool)
        # The floor FADES. A pre-season team-sheet prediction is real evidence
        # about GW1 and nearly none about GW6, by which point the model has
        # watched several actual line-ups. Holding it at full strength all
        # season pins players to a guess that has long since been superseded —
        # and, worse, keeps them pinned when the observed starts disagree.
        # `xi_floor_weight` is 1.0 at GW1 and decays by half-life; see
        # config.XI_FLOOR_HALFLIFE and pipeline.minutes_by_gameweek.
        w_xi = float(np.clip(xi_floor_weight, 0.0, 1.0))
        lg = pd.Series(np.where(is_gk_all, XI_NAIL_FLOOR_GK, XI_NAIL_FLOOR),
                       index=r.index) * w_xi
        # Every named player, measured or not. A record only ever RAISES the
        # claim below; it must not be able to lower it, or a first-choice
        # player coming off an injury-shortened season is ranked beneath his
        # own club's fringe. Saka, named in Arsenal's XI, was allocated 24
        # minutes a game on a 0.67 share from a year he spent half injured.
        nail_floor[named] = lg[named]

    a = (pd.Series(1.0, index=r.index) if avail is None
         else pd.to_numeric(avail, errors="coerce").fillna(1.0).clip(0.0, 1.0))

    out = pd.DataFrame({
        "exp_mins": 0.0, "nailed": 0.0, "role_lambda": 1.0,
        "role_shortfall": False,
    }, index=r.index)

    is_gk = is_gk_all
    pos_up = position.astype(str).str.upper()
    for club, idx in team.groupby(team).groups.items():
        idx = pd.Index(idx)
        # ---- positional budgets -------------------------------------------
        # A club's outfield minutes are not one undifferentiated pool. Treating
        # them as one meant an injured centre-back's minutes flowed to whoever
        # was next in the whole outfield squad — including forwards — so a
        # defensive injury quietly promoted a striker. Minutes freed by a
        # defender go to defenders.
        #
        # Budgets are measured, not assumed. Minutes per team per match by
        # position, 2023-24 to 2025-26: DEF 369.8, MID 426.8, FWD 98.4, GK
        # 90.0 — a 41.3 / 47.7 / 11.0 outfield split.
        #
        # The league split is an anchor, not a straitjacket: a side that plays
        # three at the back genuinely spends fewer minutes on defenders, so the
        # club's OWN role-score composition gets equal weight. Shrinking rather
        # than choosing one keeps a thin or lopsided squad from being handed an
        # implausible budget.
        groups = []
        if positional_budget:
            of = idx[~is_gk.loc[idx].to_numpy()]
            if len(of):
                s = pd.Series(
                    {p: float(r.loc[of][pos_up.loc[of] == p].sum())
                     for p in ("DEF", "MID", "FWD")})
                tot = float(s.sum())
                sel_by_pos, target, capacity = {}, {}, {}
                for p in ("DEF", "MID", "FWD"):
                    sel_p = of[pos_up.loc[of].to_numpy() == p]
                    if len(sel_p) == 0:
                        continue
                    sel_by_pos[p] = sel_p
                    club_share = (s[p] / tot) if tot > 0 else POS_BUDGET_SHARE[p]
                    share = 0.5 * club_share + 0.5 * POS_BUDGET_SHARE[p]
                    target[p] = budget_outfield * share
                    # The most this position could deliver if every available
                    # player in it started and played to his own ceiling.
                    capacity[p] = float(
                        (cap.loc[sel_p] * a.loc[sel_p]).sum())

                # A positional budget is a PREFERENCE, not a cap. A thin squad
                # cannot fill one — Hull's registered defenders and forwards
                # cannot cover a league-average allocation between them — and
                # enforcing it regardless left the club fielding 746 outfield
                # minutes instead of 921.8, i.e. nine men. The single-pool
                # version never had that failure because midfielders silently
                # absorbed the slack, which is precisely the behaviour this
                # change exists to stop.
                #
                # So: trim any target a position cannot meet, and spill the
                # remainder onto the positions that still have headroom, in
                # proportion to how much headroom each has. A defender's freed
                # minutes still go to defenders first; they only reach a
                # midfielder once no defender can take them. The club total is
                # preserved by construction, which is the invariant that
                # matters — eleven players have to be on the pitch.
                for _ in range(4):
                    spill = 0.0
                    for p in list(target):
                        if target[p] > capacity[p]:
                            spill += target[p] - capacity[p]
                            target[p] = capacity[p]
                    if spill <= 1e-6:
                        break
                    head = {p: max(0.0, capacity[p] - target[p]) for p in target}
                    tot_head = sum(head.values())
                    if tot_head <= 1e-6:
                        break     # genuinely short: role_shortfall will flag it
                    for p in target:
                        target[p] += spill * head[p] / tot_head

                for p, sel_p in sel_by_pos.items():
                    groups.append((sel_p, target[p], POS_XI_SLOTS[p]))
            gksel = idx[is_gk.loc[idx].to_numpy()]
            if len(gksel):
                groups.append((gksel, budget_gk, 1))
        else:
            for gk_group, budget in ((True, budget_gk), (False, budget_outfield)):
                sel_g = idx[is_gk.loc[idx].to_numpy() == gk_group]
                if len(sel_g):
                    groups.append((sel_g, budget,
                                   1 if gk_group else XI_SLOTS_OUTFIELD))

        for sel, budget, slots_override in groups:
            gk_group = bool(is_gk.loc[sel].iloc[0])
            if len(sel) == 0:
                continue
            n = nailed.loc[sel].to_numpy()
            c = cap.loc[sel].to_numpy()
            av = a.loc[sel].to_numpy()
            fl = nail_floor.loc[sel].to_numpy()
            # A club's own measured players are floored at their own record —
            # but only the top XI_SLOTS of them, because that is how many can
            # be in the team. Flooring every player with a record lets fifteen
            # claims compete for eleven shirts, which over-subscribes the
            # budget and forces a scale-back that punishes everyone; flooring
            # none of them lets water-filling dilute a certain starter among a
            # deep squad, which is how Haaland ended up at a 66% chance of
            # starting for Manchester City.
            #
            # Eleven claims at a typical 0.85 nail and 85 minutes come to about
            # 795 against a 921.8 budget, so by construction this can fit.
            slots = slots_override
            # A player's claim on a shirt is the better of his own measured
            # rate and, if a predicted XI names him, the league-average
            # first-choice rate. The second half matters for a good player
            # coming off an interrupted season: Saka is named in Arsenal's XI
            # but his 0.67 share from an injury-hit year ranked him outside the
            # club's top ten, so on his own record alone he was allocated a 40%
            # chance of starting. Being named is the evidence that the injury
            # year is behind him.
            own = np.maximum(raw_nail.loc[sel].to_numpy()
                             * measured.loc[sel].to_numpy(),
                             fl)
            # NAMED players take the slots first. A predicted XI is current
            # information about who the manager intends to pick; a minutes
            # record is history. When the two compete for the same shirt the
            # intent wins, and only the leftover slots go to unnamed players on
            # the strength of their record.
            #
            # Without this ordering an unnamed player with a big record simply
            # outbid a named one with a modest record, and it kept producing
            # the same casualty: Riccardo Calafiori, named in Arsenal's XI,
            # allocated 19 minutes a game because Declan Rice's 0.89 share
            # outranked his 0.74 floor for the last slot.
            is_named = (predicted_xi.reindex(r.index).fillna(False)
                        .astype(bool).loc[sel].to_numpy()
                        if predicted_xi is not None
                        else np.zeros(len(own), dtype=bool))
            # A naming BREAKS TIES; it does not outrank evidence.
            #
            # This was +10.0 against an `own` that never exceeds 1.0, so being
            # printed on a pre-season team sheet beat any record whatsoever.
            # The measured consequence at Arsenal: Declan Rice, 3,093 minutes
            # and a 92% real start rate, came out at a 39% chance of starting
            # and 34 expected minutes, while Mosquera (986 minutes, 24% real
            # start rate) and White (699 minutes, 24%) sat at 100% purely for
            # being named. Across the registry the model over-started players
            # by 10 percentage points on average, 154 of them by 10pp or more.
            #
            # `own` already carries the naming: it is max(own record, XI
            # floor), so a named player the model knows nothing about is
            # lifted to the floor by that alone. The bonus here only needs to
            # settle a genuine tie, and anything larger lets a guess overrule
            # three thousand minutes of evidence.
            rank_key = own + np.where(is_named, XI_NAME_TIEBREAK, 0.0)
            if len(own) > slots:
                cut = np.partition(rank_key, -slots)[-slots]
                fl = np.where(rank_key >= cut, own, 0.0)
            else:
                fl = own
            # Floors are claims on a fixed budget and can over-subscribe it: a
            # squad containing fourteen players with a 0.85 measured share is
            # describing a team that cannot all play. When that happens the
            # claims are scaled back proportionally — every player keeps the
            # same SHARE of his claim, so the ordering is untouched.
            #
            # Two wrong versions preceded this. Scaling was tried first and
            # rejected because it appeared to charge the most certain starter
            # the same percentage as the thirteenth man. Honouring floors
            # greedily in rank order and dropping the rest to zero was tried
            # next, and was worse: it puts a cliff at the budget line. Saka sat
            # on 61 minutes through GW1-5 and 8 minutes from GW6, because
            # Saliba and Timber returning from injury pushed Arsenal's claims
            # over the line and he was the man who fell off it. A player's
            # projection should not collapse because someone else got fit.
            #
            # Proportional scaling has no cliff, and the floor can never drag
            # anyone BELOW the allocation they would have had without it, which
            # is what the max() against the unconstrained solve guarantees.
            claim = av * c * fl
            claim_total = float(claim.sum())
            if claim_total > budget:
                fl = fl * (budget / claim_total)
            # Water-fill on minutes, with each player capped at his own
            # minutes-per-start rather than a uniform 90, and named starters
            # floored at the measured pick rate for a first-choice player.
            lam = _solve_lambda(n, c, av, budget, fl)
            picked = _picked(lam, n, fl)
            m = av * picked * c
            out.loc[sel, "exp_mins"] = m
            out.loc[sel, "nailed"] = picked
            out.loc[sel, "role_lambda"] = lam
            out.loc[sel, "role_shortfall"] = bool(m.sum() < budget * 0.97)

    out["mins_share"] = (out["exp_mins"] / 90.0).clip(0.0, 1.0)
    return out


def load_curves() -> dict:
    """Fitted minutes curves, or the fitted values inlined as a fallback.

    The fallback is not a guess — it is the output of `python -m
    fplab.fit_minutes` on 2,959 player-seasons, copied here so a fresh clone
    projects correctly before the fit has been run.
    """
    path = DATA / "minutes_curves.json"
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {
        "p_start_exp": 1.1230,
        "p_60_exp": 1.1521,
        "p_play_exp": 0.5822,
        "mps_intercept": 71.3058,
        "mps_slope": 17.1357,
        "budget_outfield": BUDGET_OUTFIELD,
        "budget_gk": BUDGET_GK,
    }


def probabilities(mins_share, curves: dict | None = None,
                  nailed=None) -> pd.DataFrame:
    """
    P(start), P(60), P(play) for an allocated player.

    `nailed` is the allocator's own pick probability and is used directly when
    given. Re-deriving P(start) from the minutes share instead is subtly wrong
    for anyone who does not play the full ninety: Haaland is withdrawn on 86
    minutes, so an allocation of 64 minutes is a 0.74 share but a 0.74 pick
    probability would be reading his substitutions as a selection risk. The
    allocator already knows which is which; the share does not.
    """
    c = curves or load_curves()
    s = np.clip(np.asarray(mins_share, dtype=float), 0.0, 1.0)
    p_start = (np.power(s, c["p_start_exp"]) if nailed is None
               else np.clip(np.asarray(nailed, dtype=float), 0.0, 1.0))
    p_60 = np.power(s, c["p_60_exp"])
    p_play = np.clip(np.power(s, c["p_play_exp"]), p_start, 1.0)
    return pd.DataFrame({"p_start": p_start, "p_60": np.minimum(p_60, p_play),
                         "p_play": p_play})


def depth_report(before: pd.Series, after: pd.Series, meta: pd.DataFrame,
                 top: int = 25) -> pd.DataFrame:
    """Who gained and lost minutes to the conservation step. For eyeballing."""
    d = meta.copy()
    d["before"] = before
    d["after"] = after
    d["delta"] = after - before
    return d.reindex(d["delta"].abs().sort_values(ascending=False).index).head(top)
