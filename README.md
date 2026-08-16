# FPL Lab

Expected-points engine, penalty model and multi-period squad optimiser for FPL 2026/27.

**Runs on 100% real data.** No synthetic generators, no invented numbers, no demo mode.
Every rate, price, fixture and rating traces to an actual source, and the model is
backtested against a real completed season.

```bash
pip install -r requirements.txt
python -m fplab.build_real      # real dataset, ~30s
python -m fplab.backtest        # real walk-forward validation
streamlit run app.py
```

---

## Backtest — real 2025/26, walk-forward

Trained on gameweeks `< g`, tested on `g`, walked forward across 30 gameweeks
(11,498 real player-gameweek rows).

| Metric | Value |
|---|---|
| MAE | 2.09 points |
| Spearman rank correlation | 0.304 |
| Top-20 ranked picks | **4.39 pts** vs field average **3.00** |
| Perfect hindsight ceiling | 11.06 |

Forward-chaining is mandatory. A random train/test split leaks the future through
rolling form and will make a bad model look excellent — any FPL tool quoting an r²
from a shuffled split is quoting a fantasy.

### What actually drives points (fitted, standardised)

| Position | mins | price | form5 | home | xG90 | opp_def | DefCon |
|---|---|---|---|---|---|---|---|
| DEF | 0.301 | 0.361 | 0.147 | 0.223 | 0.099 | 0.094 | 0.023 |
| MID | 0.494 | 0.354 | 0.196 | 0.137 | 0.041 | 0.033 | −0.019 |
| FWD | 0.473 | 0.549 | 0.223 | 0.090 | −0.171 | −0.016 | −0.090 |
| GK | −0.071 | 0.274 | 0.119 | 0.172 | −0.086 | 0.145 | — |

**The headline finding: minutes and price dominate everything else.** Not xG, not
fixture. That answers the original question honestly — an elite xG rate on a rotated
player loses to a mediocre rate on a nailed one, every time.

Two caveats stated plainly:
- `price` is partly a *proxy* for quality and minutes, so it absorbs signal that
  belongs to xG. The negative FWD xG coefficient is collinearity, not evidence that
  xG is bad for strikers.
- `start_roll` was dropped: it correlated 0.983 with `mins_roll`, splitting one real
  effect into +0.99/−0.70 nonsense. Removing it left accuracy identical (MAE 2.092 vs
  2.091) and made every coefficient readable.

---

## Data — every source real

| Source | Provides | Reachable |
|---|---|---|
| vaastav/Fantasy-Premier-League `2026-27` | 567 registered players, real prices, positions, penalty order, current clubs, 380-fixture calendar | ✅ GitHub |
| vaastav/Fantasy-Premier-League `2025-26` | complete season: 29,757 player-gameweeks of real xG, xA, DefCon, bps, minutes | ✅ GitHub |
| FPL API (`bootstrap-static`, `entry/{id}/picks`) | live in-season prices, injury flags, your own squad | ⚠️ blocks datacentre IPs — works from your machine |
| Understat | independent xG cross-check | ⚠️ same |

The archived vaastav data **is** FPL's own numbers for a finished season, so nothing is
lost by using it. `sources.py` still implements the live path for in-season use.

---

## The model

### Team strength
Real per-match team xG, exponentially decayed (half-life 8), shrunk toward a prior:

```
AttStr_t  = xGF90_t / league_avg        DefWeak_t = xGA90_t / league_avg
```

Real 2025/26 output: Arsenal's league-best defence at **0.769**, Man City top attack at
**1.182** — matching the actual title race.

### Fixture model
Dixon–Coles attack/defence Poisson:

```
λ_home = μ · AttStr_home · DefWeak_away · H        H = 1.12
λ_away = μ · AttStr_away · DefWeak_home / H
CS_prob = e^(−λ_opp)
```

**Two difficulty ratings per fixture**, not one — attacking (from `λ_for`) and defensive
(from `λ_against`). A trip to a leaky high-scoring side is *easy* for your forwards and
*hard* for your defenders at once. Official FPL FDR collapses both into a single integer,
which is why its ticker misleads.

### Promoted teams
Coventry, Ipswich and Hull have no PL history. Earlier versions silently **dropped every
fixture involving them**, which also deleted the easiest fixtures for the other 17 clubs.
They now get a promoted-side prior (att 0.82, def 1.22) adjusted by promotion route —
champions up, play-off winner down — and decay toward reality as real matches arrive.

### Penalties
```
pen_xG90 = LEAGUE_PEN_RATE · AttStr^0.6 · order_share · 0.79
order_share = {1: 0.84, 2: 0.12, 3: 0.03, 4: 0.01}
```
Order comes from FPL's real `penalties_order`. **No listed order → zero penalty xG.**
No guessing, no splitting penalties across a team's forwards.

The double-counting trap: FPL's `expected_goals` already includes penalties, so a taker's
prior has pen xG baked in. Corrected in two steps, possible only because we have real
taker order for *both* seasons:

```
npxG90_prior = xG90_prior − penXG90(LAST season's order)
xG90_model   = npxG90_prior + penXG90(THIS season's order)
```

Real output — Liverpool, exactly as listed by FPL:

| Player | Order | pen xG/90 | non-pen xG/90 | total |
|---|---|---|---|---|
| Isak | 1 | 0.089 | 0.336 | 0.425 |
| Szoboszlai | 2 | 0.013 | 0.120 | 0.133 |
| Gakpo | 3 | 0.003 | 0.271 | 0.275 |

≈4.3 penalties per season for a first-choice taker — the correct real-world rate.
A player who *lost* pen duty over the summer correctly loses that xG too.

### Minutes — the biggest single lever
The backtest proves minutes dominate, so this gets real treatment.

Raw last-season minutes share badly misprices anyone who missed time. **Isak played 694
minutes in 2025/26** (injury + transfer saga) → 0.20 share → projected **4.6 points over
six gameweeks** for a £9.0m nailed striker. Absurd.

Fix: shrink observed minutes toward a **price-implied** expectation, fitted from real data
(median minutes share of same-position players within ±£0.75m who played over half a
season). Price is the market's own consensus on who starts.

```
w = observed_minutes / (observed_minutes + 900)
```
Isak: 0.203 → **0.46**. Haaland (2,953 mins) barely moves: 0.863 → 0.815.

**Two-tier guard.** The old single flat cap (0.45 for anyone under 180 minutes) conflated
two opposite situations and got both wrong. A player who had a full Premier League season
available and still played 265 minutes is not missing data — that is strong evidence he is
third or fourth choice. A genuine new arrival's minutes really are unknown. Both were
landing on 0.45, and combined with `price_implied_production` handing out a plausible
xG/90, cheap fringe forwards surfaced near the top of xP-per-£m (Marc Guiu was the case
that exposed it: a 0.53 share, 47 minutes a game, no realistic route to the pitch).

Each ceiling scales with price percentile **within position** — a £6.0m defender is
expensive, a £6.0m midfielder is not, and ranking on raw price across positions flatters
cheap forwards, which is the exact failure mode:

```
observed_share = prior_minutes / 3420
fringe_cap     = clip(0.10 + 0.25*price_pct + 0.90*observed_share, 0.06, 0.75)   # mins < 1200
signing_cap    = clip(0.20 + 0.60*price_pct, 0.20, 0.85)   # mins < 180 AND newly arrived
mins_share     = min(mins_share, ceiling)
```

Routing: a player labelled a new signing who *does* have 180+ PL minutes takes the fringe
path — we have evidence about him. Above 1,200 minutes no ceiling binds at all.

| Case | Prior mins | Raw share | Ceiling | Final | xMins | Flag |
|---|---|---|---|---|---|---|
| Haaland | 2,953 | 0.815 | — | 0.815 | 73 | — |
| Isak | 694 | 0.460 | 0.53 | 0.460 | 41 | fringe (does not bind) |
| Rashford | 0 | 0.743 | 0.33 | 0.335 | 30 | fringe |
| Marc Guiu | 265 | 0.526 | 0.24 | **0.236** | **21** | fringe → gated |
| £4.0m 3rd keeper | 0 | 0.819 | 0.18 | 0.181 | 16 | fringe → gated |

**Clear-#1 goalkeeper floor.** The opposite correction. GK minutes are bimodal — a fit
first choice plays 90 or nothing — so linear shrinkage reads an injury-shortened season as
rotation. Alisson (2,340 real minutes) was blending to 0.74 and projecting *below* £5.0m
starters. Where a club has one strictly highest-priced keeper with a real record, the
market is unambiguous, and he is floored at the fitted fit-keeper share for his price
(0.892). Tied prices are left alone — that is a real selection battle.

**Optimiser eligibility gate.** `MIN_EXPECTED_MINUTES` (default 25/game) drops a player
from the pool entirely rather than down-weighting him: below that nobody clears the
60-minute appearance point often enough to justify a slot, and fringe per-90 rates are the
least reliable numbers in the model. 147 of 567 players are currently gated.
`must_include` and `data/overrides.csv` always win.

All six constants above are **hand-picked, not fitted** — see Known limits.

### Expected points
```
xP = P(60)·2 + (P(play) − P(60))·1
   + xG_fix · G_pos              6 GK/DEF, 5 MID, 4 FWD
   + xA_fix · 3
   + CS_prob · CS_pos · P(60)
   + P(DefCon hit) · 2           10 CBIT def · 12 CBIRT mid/fwd
   + xBonus(BPS) + xSaves/3
   − E[⌊GC/2⌋] · P(60)           exact Poisson, not λ/2
   − E[cards]
```
Rates convert to a **share of team output** then rescale by fixture λ — the mechanism
that makes weak opposition defence flow through to the individual.

### Season blending
Credibility shrinkage, not fixed ratios: `w_now = n/(n+K)`, n = 90s played.
GW1 → 0.00 (100% prior) · GW8 → 0.50 · GW20 → 0.70. Pre-season sits correctly at w=0.

---

## Optimiser

True multi-period MILP. Per player *i*, per gameweek *g*:

```
own[i,g] = own[i,g-1] + buy[i,g] − sell[i,g]
ft[g]   <= ft[g-1] + 1 − transfers[g-1] + hits[g-1]     bank capped at 5
hits[g] >= transfers[g] − ft[g]

max Σ_g d^g ( Σ_i xp[i,g]·(start+capt) + 0.12·Σ_i xp[i,g]·bench ) − 4·Σ_g hits[g]
```

Budget enforced every gameweek. Blanks → 0, doubles → summed.

| Mode | Behaviour |
|---|---|
| Wildcard / fresh build | one squad held across the horizon |
| Weekly | current squad + 1 GW, capped by free transfers |
| Horizon | transfers planned per week — tells you *when* to roll and *when* to hit |

**Custom teams:** `must_include` / `must_exclude` as hard constraints, ownership screens
for differentials, max-per-club. **Alternatives** via no-good cuts, each with xP gap and
overlap. **Infeasible models never return a squad** — they return a plain-English
diagnosis (`"must_include has 4 from T00 (max 3)"`).

---

## Sample real output (GW1–6, £100.0m)

Haaland ranks #1 on raw xP (31.8) and Bruno #2 (31.6) — the model agrees with the market
where the market is right, and the optimiser then prices in value.

```
Raya (ARS) 6.0 · Petrović (BOU) 4.5
Senesi* (TOT) 6.0 · van Dijk (LIV) 6.5 · Tarkowski (EVE) 6.0 · Guéhi (MCI) 6.0 · van Hecke* (TOT) 5.0
Bruno (MUN) 12.0 · Anderson* (MCI) 6.5 · Enzo (CHE) 7.0 · Semenyo (MCI) 8.5 · Garner (EVE) 6.0
Thiago (BRE) 8.0 (C) · Mateta (CRY) 6.5 · Ünal (BOU) 5.5
```

Garner at **0.8% ownership** is the model's biggest differential call, driven by DefCon
volume. Treat that as a hypothesis the backtest supports weakly (DefCon coefficient is
small), not a lock.

---

## Layout

```
fplab/
  config.py       2026/27 scoring rules + hyper-parameters
  build_real.py   full real dataset assembly        ← start here
  build_prior.py  real historical season ingestion
  sources.py      live FPL API + Understat + name matching
  ratings.py      team strength, Poisson fixtures, dual FDR
  promoted.py     promoted-side priors
  penalties.py    taker order, pen xG, double-count correction
  minutes.py      price-informed minutes model
  blend.py        credibility shrinkage, new-signing translation
  xpts.py         expected points
  optimize.py     multi-period MILP + diagnostics
  backtest.py     walk-forward validation + coefficient fitting
  pipeline.py     orchestration, squad import
app.py            Streamlit UI (6 tabs incl. Penalties & Data audit)
tests/            12 optimiser tests
```

---

## Known limits — read before trusting it

1. **Injury flags are unavailable pre-season.** Re-run against live `bootstrap-static`
   nearer GW1 from your own machine to pick them up.
2. ~~**Bonus curve is a logistic I chose, not fitted.**~~ **Fitted.** `python -m
   fplab.fit_bonus` now refits amplitude/centre/scale against all 7,815 real 60+ minute
   appearances of 2025/26: `amp 2.735, centre 31.44, scale 3.23` (corr 0.856, mean fitted
   bonus 0.301 vs real 0.294), replacing the hand-picked 1.85/28/6. Note the backtest's
   negative `bps90_roll` coefficient is a *different quantity* — that is a feature weight
   inside the Ridge model, collinear with minutes and price, not a verdict on
   `expected_bonus`.
3. **No price-change model** — team value is ignored in horizon planning.
4. ~~**Chips beyond wildcard aren't decision variables.**~~ Bench Boost and Triple Captain
   are now real MILP variables (`solve(..., chips=True)`): at most one week each, chosen by
   the solver, with the bench scoring in full in the BB week and the captain trebling in
   the TC week. Free Hit is deliberately *not* a variable — a Free Hit squad is by
   definition the single-week optimum, which `solve(proj, [g])` already computes exactly.
5. **Spearman 0.304** is respectable for single-gameweek FPL prediction but means large
   individual errors are normal. The edge is real and modest: 4.39 vs 3.00 points on
   top-20 picks, roughly a 46% uplift, not clairvoyance.
6. **New signings from abroad are understated** by the signing ceiling. Use
   `data/overrides.csv` for the ones you have a view on.
7. **The minutes-guard constants are hand-picked, not fitted.** All six
   (0.10/0.25/0.90/0.06/0.75 fringe, 0.20/0.60 signing) and the 25-minute gate are my
   judgement, unlike the bonus curve which is now fitted to real pairs. The walk-forward
   backtest **cannot validate them**: `backtest.py` fits a Ridge model on rolling
   per-gameweek features and never imports `minutes.py` or `xpts.py`, so it exercises a
   different code path entirely. Its numbers are unchanged at MAE 2.092 / Spearman 0.304 /
   4.39 vs 3.00 — that is a statement about disjoint code, not evidence the guard works.
   Validating it properly needs a backtest that replays the *xP engine* pre-season and
   scores its rankings against realised points; that harness does not exist yet.
8. **Loan returns are routed as fringe, not new signings.** `is_new_signing` is derived
   from `prior_team != current_team`, so a player who spent 2025/26 on loan abroad and
   returned to the same club (Rashford, Kulusevski) reads as a zero-minute squad player.
   The price percentile rescues them in practice (~30 xMins, above the gate), but the
   routing is wrong in principle and a real loan flag would fix it.

---

## Since the last README pass

- **`fplab/rules_2026_27.py`** — real, confirmed 2026/27 rule changes.
  DefCon and chips are unchanged; BPS was recalibrated to reduce overlap with
  DefCon (FPL's own stated reason: 112 matches where defenders double-dipped
  on the same CBI actions). Measured on real 2025/26 data: CBI was 23.4% of a
  defender's BPS versus 4–7% elsewhere, so the cut lands ~5x harder on
  defenders. `adjust_bps_for_2026_27` restates every prior BPS rate under the
  new weighting before it feeds the bonus-points model. `CBI_BPS_RETAINED`
  (default 0.5) is the one unconfirmed coefficient — FPL published the
  direction, not the exact number.
- **`fplab/minutes.py::price_implied_production`** — players with no usable
  PL history (transfers from outside the top five leagues, long loans
  abroad — Rashford, Kulusevski, N.Jackson, etc.) were projecting zero
  attacking output. Understat blocks datacentre IPs and the open multi-league
  GitHub datasets stop at 2021/22, so there's no real foreign-league xG
  reachable from a sandbox. Price stands in instead — FPL's own analysts set
  pre-season prices with full knowledge of a signing's record, so it's a
  compressed expert estimate of exactly what's missing. Flagged
  `price_implied_prior`; override with real numbers in `data/overrides.csv`
  whenever you have a better view than the proxy.
- **`webapp/`** — the React pitch/squad-builder, exported here as source
  (`app.jsx`) plus a data-export script, rather than only the
  placeholder-injected artifact. See `webapp/README.md` for how to turn this
  into a proper Vite dev loop.
