"""
Central configuration: FPL scoring rules (2026/27) and model hyper-parameters.

Every number that encodes a *rule* lives here so that when FPL tweaks the game
you change one file, not the model.  Every number that encodes a *belief*
(decay rates, shrinkage constants) is also here, and most of them can be
re-fitted from history by fplab.calibrate.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# FPL scoring rules (2026/27)
# ---------------------------------------------------------------------------
POSITIONS = ["GK", "DEF", "MID", "FWD"]

GOAL_POINTS = {"GK": 6, "DEF": 6, "MID": 5, "FWD": 4}
ASSIST_POINTS = 3
CLEAN_SHEET_POINTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
APPEARANCE_POINTS_SHORT = 1          # played at all
APPEARANCE_POINTS_LONG = 2           # 60+ minutes
SAVES_PER_POINT = 3                  # GK only
GOALS_CONCEDED_PENALTY_EVERY = 2     # GK/DEF: -1 per 2 conceded
PENALTY_MISS = -2
OWN_GOAL = -2
YELLOW_CARD = -1
RED_CARD = -3

# Defensive Contribution ("DefCon") — unchanged for 2026/27.
# DEF: 10+ CBIT (clearances, blocks, interceptions, tackles)
# MID/FWD: 12+ CBIRT (as above + ball recoveries)
# Capped at 2 points per match, once only.
DEFCON_POINTS = 2
DEFCON_THRESHOLD = {"GK": None, "DEF": 10, "MID": 12, "FWD": 12}

# Bonus: 3/2/1 to the top three BPS scorers in each match.
BONUS_TIERS = (3, 2, 1)

# ---------------------------------------------------------------------------
# Squad rules
# ---------------------------------------------------------------------------
BUDGET = 100.0
SQUAD_SIZE = 15
SQUAD_QUOTA = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
XI_SIZE = 11
XI_MIN = {"GK": 1, "DEF": 3, "MID": 2, "FWD": 1}
XI_MAX = {"GK": 1, "DEF": 5, "MID": 5, "FWD": 3}
MAX_PER_CLUB = 3
TRANSFER_HIT = 4          # points cost of an extra transfer
MAX_FREE_TRANSFERS = 5    # free transfers can be banked up to 5

# Eligibility gate: expected minutes per game below which a player cannot hold
# a squad slot, however good his per-90 rates look. Under ~25 minutes nobody
# clears the 60-minute appearance point often enough to be worth the place, and
# the per-90 rates of fringe players are the least reliable numbers we have.
# must_include always overrides this — see optimize.solve.
MIN_EXPECTED_MINUTES = 25.0

# FPL awards assists far more generously than Opta's expected-assists model
# counts them. Winning a penalty that is scored is an assist; so is a shot
# parried to a team-mate, a deflection that falls kindly, and a cross that
# forces an own goal — none of which generate xA, because no pass to a shot
# ever happened.
#
# Measured on all 60+ minute appearances of 2025/26, FPL awarded 796 assists
# against 579 xA — 1.374 per 1.0 xA. Goals need no such correction (0.964),
# which is the tell that this is a definitional gap and not a model bias.
#
# Per position, shrunk toward the league figure by sample size (K=100 xA), so
# the thin samples do not run the show: DEF and MID rest on 167 and 371 xA and
# are trusted; FWD (40.6 xA, raw ratio 2.12) and GK (1.4 xA, raw 3.57) are
# pulled most of the way back to the league number.
FPL_ASSIST_INFLATION = {"GK": 1.38, "DEF": 1.31, "MID": 1.33, "FWD": 1.59}

# How far a player's OWN assists-per-xA ratio may pull him off that positional
# constant. `blend.assist_multiplier` applies it.
#
# Unlike finishing, assist inflation is a repeating trait. Measured year over
# year on players with 900+ minutes and 3+ xG in both seasons
# (fplab.fit_assist_inflation):
#
#     assist ratio A/xA        r = +0.249   <- a real, weak trait
#     finishing above xG /90   r = +0.051   <- noise; deliberately NOT modelled
#     xG per 90 (control)      r = +0.803
#
# The finishing line is the reason there is no matching "clinical finisher"
# multiplier and must not be read as an oversight. At r = 0.05 last season's
# overperformance says nothing about next season's, and a player who beat his
# xG by 8 is overwhelmingly likelier to have been lucky than to be repeatable.
#
# Re-tested directly on FUTURE GOALS with a hierarchical shrinkage model, which
# is the strongest form of the "but Haaland really is a better finisher"
# argument: multiplier = 1 + (career_G/career_xG - 1) * xG/(xG + K), so a
# one-season overperformer is crushed to nothing while a multi-season,
# high-volume finisher keeps a personal edge. Predicting each season's goals
# from that season's xG times the multiplier, fitted only on prior seasons:
#
#     K        2024-25 MAE      2025-26 MAE     (vs plain xG)
#     0 (trust it)   +49.7%          +35.2%     catastrophic
#     10             +9.6%           +11.9%
#     40             +0.2%           +2.7%
#     80             -0.4%           -0.3%      the optimum
#     infinite        0.0%            0.0%      = plain xG
#
# The best achievable gain is 0.3-0.4% on 141 and 168 players, which is noise,
# and it is only reached by shrinking so hard that almost nothing of the signal
# survives. Trusting career finishing outright is 35-50% WORSE than ignoring
# it. The conclusion is not "we lack the data to model finishing" — it is that
# the correct finishing multiplier is 1.0, and that is what ships.
#
# 0.25 is the credibility CEILING, and it is not a taste setting. For a signal
# whose test-retest reliability is r, the minimum-MSE shrinkage toward the
# population mean is exactly r — so a full season of evidence buys a quarter of
# the distance from the positional constant to the player's own ratio, and no
# more. Re-derived out-of-sample (predict season 2 assists from a season 1
# ratio, 192 player-season pairs) the MAE curve is U-shaped with its minimum at
# 0.25, matching the theory: MAE 1.9011 flat -> 1.8932 at w=0.25, rising again
# to 1.9461 at w=1.0. Trusting the split fully is WORSE than ignoring it.
#
# K is in xA, not matches: credibility tracks the volume of the thing being
# measured. w = 0.25 * xA/(xA+4) — a creative midfielder on 8 xA reaches 0.17,
# a defender on 1.5 xA only 0.07, and nobody reaches the ceiling on one season,
# which is the intended behaviour for a signal this weak.
ASSIST_CREDIBILITY = 0.25
ASSIST_CRED_K = 4.0

# A player's own ratio is clipped to this band before blending. FPL assists are
# integers divided by a small xA, so a fringe player with 2 assists on 0.4 xA
# reads 5.0 — an artefact of a tiny denominator, not evidence of a trait.
ASSIST_RATIO_CLIP = (0.0, 4.0)

# Negative-Binomial dispersion for DefCon counts (variance = mu + mu^2/r).
# Fitted by `python -m fplab.fit_defcon` against real 2025/26 threshold-hit
# rates, minimising squared error on P(hit) at each player's own rate.
#
# These sit far above the pooled method-of-moments values (r ~ 7) on purpose:
# most of the raw variance/mean ratio of 1.6-2.1 is BETWEEN-player spread, not
# a single player's match-to-match burstiness. Conditioned on a player's own
# rate — which is how the engine uses it — the residual overdispersion is
# mild, and fitting it on that basis is the honest number.
DEFCON_DISPERSION = {"DEF": 34.77, "MID": 43.34, "FWD": 33.66}

# ---------------------------------------------------------------------------
# Model hyper-parameters
# ---------------------------------------------------------------------------

# Home advantage multiplier on expected goals.
#
# Set to 1.0 deliberately — NOT because home advantage does not exist, but
# because it is already measured. `ratings.team_ratings` estimates att_home /
# att_away and def_home / def_away separately from real match data, so the
# product att_home x def_away already carries both halves of the effect:
#
#     home lambda  = mu * 1.062 * 1.062 = mu * 1.128
#     away lambda  = mu * 0.954 * 0.954 = mu * 0.910
#     implied ratio                       1.239
#     real 2025/26 (home xG 1.551 / away xG 1.264)  1.227   <- matches
#
# Multiplying by a further 1.12 at home and dividing by it away applied the
# same effect twice, inflating the spread to 1.55 against a real 1.23. Away
# fixtures were systematically over-penalised: Man Utd AWAY at Hull — the
# leakiest defence in the league — was rated a harder attacking fixture (6.8)
# than most mid-table HOME ties, which is football nonsense and was caught by
# exactly that observation.
HOME_ADVANTAGE = 1.0

# Exponential decay half-life (in matches) for rolling team form, and how many
# of a club's most recent matches enter the estimate at all.
#
# These were 8 and 19 — a nineteen-match window, so roughly nine home and nine
# away games, with the oldest of them down at 20% weight. That is far too
# little evidence to rate a defence, and it showed: Liverpool came out at
# def_ = 0.999, exactly league average, purely because 2025/26 was an off
# season for them. Home games against Liverpool were consequently rated GREEN
# fixtures, and three of the calendar's "easiest" attacking fixtures were trips
# to Anfield. No amount of recolouring fixes a rating that says an elite
# defence is average.
#
# 114 matches is three full seasons (see fplab.team_history) and a 30-match
# half-life weights them roughly 55% / 30% / 15%, so the current season still
# dominates but a single bad year cannot erase a club's established level.
# Decay is positional within each club's own history, so a promoted side is
# still rated on the 38 matches it actually has.
TEAM_FORM_HALFLIFE = 30.0
TEAM_FORM_WINDOW = 114

# Credibility shrinkage constant K, in 90s played.
# w_now = n / (n + K).  K=8 => 50/50 blend at ~8 full matches.
SHRINK_K_ATTACK = 8.0     # xG / xA rates
# DefCon, set from measurement rather than assumption. `defensive_contribution`
# exists only in the 2025/26 export (the season the rule was introduced), so a
# year-over-year reliability is not computable — there is no second year. The
# defensible substitute is split-half within the season, on ODD vs EVEN
# gameweeks so that form, transfers and fixture runs do not masquerade as
# unreliability, Spearman-Brown corrected to full-season length:
#
#     group   r(half)   r(full)   implied K
#     ALL      0.898     0.946        1.3
#     DEF      0.827     0.906        2.3
#     MID      0.769     0.869        3.3
#     FWD      0.745     0.854        3.8
#
# The pooled 1.3 is an artefact — it is inflated by the gap BETWEEN positions
# (a centre-back and a striker make wildly different numbers of defensive
# actions), which is not the quantity being estimated. The within-position
# figures are the honest ones and they cluster at 2.3-3.8.
#
# 3.0 rather than the measured 2.3-3.3, deliberately. Split-half is a
# WITHIN-season measurement, and nothing that resets a player's defensive
# volume — a transfer, a new manager, a change of role — happens inside a
# season the way it happens between two. So the measurement is an upper bound
# on reliability and therefore a lower bound on K, and taking it literally
# would trust one autumn's tackling more than the evidence supports.
SHRINK_K_DEFCON = 3.0
# BPS is far noisier than the attacking rates it was sharing a constant with:
# split-half r(full) is 0.572 pooled and 0.374-0.606 within position, implying
# K ~ 14-37 against the 8.0 it was being blended at. Bonus is a rank-order
# award decided by whoever else happened to play well that afternoon, so a
# player's own BPS rate carries much less signal than it appears to. 16.0 is
# the pooled measurement; the within-position spread is too wide to split.
SHRINK_K_BPS = 16.0
SHRINK_K_MINUTES = 5.0
SHRINK_K_NEW_SIGNING = 4.0  # trust new data faster for transfers-in

# ---------------------------------------------------------------------------
# Horizon confidence: how much a projection is worth t gameweeks out.
# ---------------------------------------------------------------------------
# FITTED, and the fit disagrees sharply with the intuition it replaced.
#
# Method: freeze the engine's knowledge t gameweeks in the past while still
# asking it about the current fixture, so t+1 is the forecast horizon, and
# score each against what actually happened. Thirty walk-forward passes, three
# seasons, pooled:
#
#     horizon   MAE     rho     rho/rho_1   hit@20
#        1     2.006   0.3480     1.000      0.221
#        2     2.025   0.3327     0.956      0.218
#        4     2.061   0.3083     0.886      0.218
#        6     2.073   0.3013     0.866      0.223
#        8     2.086   0.2953     0.849      0.212
#       10     2.100   0.2903     0.834      0.210
#
# An exponential fitted to rho/rho_1 gives decay = 0.9758, and it is stable
# across seasons (0.9774 / 0.9796 / 0.9698). A ten-week-ahead projection keeps
# 83% of its rank correlation and costs 4.7% of MAE. Selection quality at the
# top of the board barely moves at all: hit@20 goes 0.221 -> 0.210.
#
# For contrast, the 0.85 that "felt right" implies 0.85^9 = 0.232 at ten weeks
# out — it would discard three quarters of a signal that measurement says is
# still almost entirely there. Using it would have been an assumption wearing a
# measurement's clothes.
#
# The SHAPE is not exponential and the bands should respect that: two thirds of
# the total rho loss (0.040 of 0.058) happens by horizon 4, and the curve is
# flat afterwards. Information about a fixture decays quickly for a month and
# then stops decaying, rather than fading smoothly forever.
#
# WHAT THIS DOES NOT MEASURE, and it matters: every origin here sits at GW8 or
# later, so the model always had seven-plus gameweeks of observed minutes. This
# is the mid-season regime. Projecting GW12 from AUGUST — no current-season
# minutes at all, transfers unsettled, no observed line-ups — is a different
# and almost certainly worse problem, and no backtest built from this archive
# can reach it. The pre-season caution belongs in the UI on its own evidence,
# not on the back of this number.
HORIZON_CONFIDENCE_DECAY = 0.976

# Where the confidence curve changes character, from the fit above: the drop
# runs to horizon 4 and plateaus after. These are the bands the app shows.
HORIZON_BANDS = ((1, 3, "forecast"), (4, 8, "scenario"), (9, 99, "planning aid"))

# Discount applied to future gameweeks in a horizon plan.
#
# NOT the same quantity as HORIZON_CONFIDENCE_DECAY and deliberately kept
# apart. That one asks "how much do we trust this projection"; this one asks
# "how much should a squad commit to it today", which is a question about
# transfer optionality — a manager gets a free transfer a week and need not own
# GW6's points in GW1. Conflating the two would double-count. This value is
# still an assumption and is labelled as one on the methodology page.
HORIZON_DISCOUNT = 0.88

# ---------------------------------------------------------------------------
# Minutes dynamics: how a player's role moves week to week.
# ---------------------------------------------------------------------------
# RETURN RAMP — what a player actually plays in his first matches back.
#
# Fitted on 1,241 return episodes across 3,288 player-seasons (2022-23 through
# 2025-26). An episode is a run of two or more consecutive zero-minute
# gameweeks, for a player with at least three matches averaging 45+ minutes in
# the five before it. Minutes on return, as a fraction of that pre-absence
# level:
#
#     match back      n     mean   median
#         1st       1241    0.653   0.587
#         2nd       1196    0.659   0.827
#         3rd       1149    0.659   0.856
#
# The MEAN is the estimator used, because expected minutes is an expectation.
# The mean/median divergence is itself the finding: the typical returning
# player recovers quickly (median ramps 0.59 -> 0.86), but the mean stays flat
# at ~0.65 because a heavy tail never re-establishes a place. Modelling the
# median would systematically overrate everyone who comes back and does not
# hold his shirt, which is a large minority.
#
# Split by how long he was out — the reason this is a table and not a scalar:
#
#     absence      1st     2nd     3rd      n
#      2 gw       0.697   0.675   0.683    420
#      3 gw       0.708   0.672   0.688    222
#      4-5 gw     0.650   0.683   0.652    282
#      6+ gw      0.560   0.608   0.616    317
#
# Short absences are flat: a player out for a fortnight comes back to ~0.69 of
# his old role and stays there for three matches. Only long absences ramp, and
# they start much lower. The engine previously snapped every returning player
# straight back to 1.0, overstating him by about a third — worst for exactly
# the players a manager is most tempted to buy, the ones just back from a long
# injury.
RETURN_RAMP = {
    2: (0.697, 0.675, 0.683),
    3: (0.708, 0.672, 0.688),
    5: (0.650, 0.683, 0.652),
    99: (0.560, 0.608, 0.616),
}
RETURN_RAMP_MATCHES = 3

# PREDICTED-XI FLOOR DECAY — a pre-season team-sheet guess is evidence about
# GW1 and almost nothing about GW6, by which point real starts have been
# observed. Half-life in gameweeks, so weight = 0.5 ** (gw_index / halflife):
# 1.00 at GW1, 0.50 at GW3, 0.25 at GW5, 0.13 at GW7. Same decay machinery the
# team ratings use, for the same reason — old information should fade, not be
# switched off on an arbitrary gameweek.
XI_FLOOR_HALFLIFE = 2.0

# NEW-SIGNING BED-IN — a price-proxy signing does not walk into his implied
# role in week one. He climbs toward it over roughly five gameweeks; before
# that his minutes are the club's judgement, not the market's.
SIGNING_BED_IN_GWS = 5.0
SIGNING_BED_IN_START = 0.65

# Points-per-90 league baselines (recomputed from data when available).
LEAGUE_AVG_GOALS_PER_TEAM = 1.45

# League strength multipliers for players arriving from abroad.
# Applied to their previous-league xGI90 to translate it to PL terms.
LEAGUE_STRENGTH = {
    "Premier League": 1.00,
    "La Liga": 0.95,
    "Serie A": 0.94,
    "Bundesliga": 0.93,
    "Ligue 1": 0.88,
    "Primeira Liga": 0.74,
    "Eredivisie": 0.72,
    "Championship": 0.62,
    "Other": 0.65,
}

# Multiplicative calibration factors on the xP components. All 1.0 — measured,
# not lazy.
#
# `fit_components.py` fits these against real history and writes
# data/component_weights.json, which pipeline.load_component_weights() picks up
# automatically. That file is deliberately NOT shipped, because when tested the
# fitted weights made the model WORSE on both metrics that matter:
#
#     weights            calibration   correlation
#     fitted             0.891         0.8751
#     old hand-set       0.941         0.8801
#     all 1.0            0.951         0.8800   <- shipped
#
# The cause is a regime mismatch. The fit runs on a mid-season walk-forward
# sample conditioned on players who actually featured; the app projects
# pre-season, unconditionally, for every registered player. Weights learned
# under one regime and applied to the other drag clean sheets (0.65) and goals
# conceded (0.66) down for no real reason.
#
# The old hand-set 0.97/0.93 on goals and assists were never justified either
# and cost calibration, so they are gone too. Re-fit once real 2026/27 minutes
# exist and the fit regime matches the application — then compare on this same
# table before shipping the result.
DEFAULT_COMPONENT_WEIGHTS = {
    "appearance": 1.00,
    "goals": 1.00,
    "assists": 1.00,
    "clean_sheet": 1.00,
    "defcon": 1.00,
    "bonus": 1.00,
    "saves": 1.00,
    "conceded": 1.00,
    "cards": 1.00,
}
