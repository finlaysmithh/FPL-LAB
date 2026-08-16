# Team News & Starting Lineups — Product Requirements

Status: **architecture + schema spec.** Section 2 is partly shipped (see
"Shipped today"); sections 1 and 3 are designs against data the platform does
not yet ingest.

---

## 0. The honest constraint, first

This is a quantitative product. Its credibility rests on the fact that when it
shows a number, the number was measured. Three of the four requested modules
need data FPL Matrix does not currently have:

| Capability | Data required | Have it? |
|---|---|---|
| Probabilistic XI, xMins, rotation risk | start rates, minutes-per-start, availability flags | **Yes** — `fplab/minutes.py` |
| Press conference decoding | transcript feed + labelled quote→outcome corpus | No |
| "Manager says X 80% of the time" | ≥2 seasons of that manager's quotes, each resolved against what happened | No |
| Injury severity by type | injury-type-coded layoff durations | No |
| Ripple / domino effects | already derivable — see §3 | **Partly** |

The failure mode to avoid is shipping a confident-looking "Arteta means ruled
out, 80%" that was never fitted. That is worse than shipping nothing: it looks
exactly like the rest of the product, which *is* fitted, and it poisons trust in
all of it. **Every number in §1 must be gated behind a calibration check before
it renders.** The schema below carries the fields needed to enforce that.

---

## 1. The Press Conference Decoder

### 1.1 What it actually is

A **quote classifier with a per-manager calibration table**. Not an LLM asked
"what does Pep mean" — that produces fluent, unfalsifiable guesses. The pipeline:

1. **Ingest** — transcript from presser (feed or manual paste).
2. **Extract** — (player, phrase, context) triples.
3. **Classify** — phrase → intent bucket (`ruled_out`, `doubt`, `available`,
   `managed_minutes`, `non_committal`).
4. **Calibrate** — map intent → P(starts) using *that manager's* history.
5. **Gate** — if that manager has < `min_samples` resolved quotes, show the
   quote and the squad-level prior only. No fabricated percentage.

Step 4 is the entire product. It is a lookup into a table built by labelling
historical quotes against what happened that weekend. Until that table exists
the module ships as a **quote archive with model context beside it** — still
useful, and honest.

### 1.2 Calibration table (built offline, per manager per phrase-class)

```json
{
  "manager_id": "arteta",
  "phrase_class": "touch_and_go",
  "samples": 34,
  "outcomes": { "started": 4, "bench": 6, "unavailable": 24 },
  "p_start": 0.12,
  "ci95": [0.04, 0.26],
  "last_fitted": "2026-08-01",
  "confidence": "medium"
}
```

`confidence` is derived, not typed: `high` ≥ 30 samples, `medium` ≥ 12,
`low` ≥ 5, below that `insufficient` → **UI must not render a percentage**.

### 1.3 Press conference payload

```json
{
  "club": "ARS",
  "gw": 7,
  "presser_at": "2026-10-02T13:30:00Z",
  "ingested_at": "2026-10-02T14:04:11Z",
  "source": { "type": "transcript", "url": "…", "verified": true },
  "items": [
    {
      "player_id": 231,
      "player": "Saliba",
      "quote": "He's touch and go for the weekend, we'll assess him.",
      "phrase_class": "touch_and_go",
      "decoded": {
        "p_start": 0.12,
        "ci95": [0.04, 0.26],
        "confidence": "medium",
        "basis": "34 resolved Arteta quotes; started in 4",
        "reading": "Reads as available. Historically he is not."
      },
      "injury": {
        "type": "hamstring_grade1",
        "severity_score": 62,
        "median_layoff_days": 17,
        "iqr_days": [11, 26],
        "n_comparable": 148,
        "expected_return_gw": 9,
        "basis": "148 comparable PL cases, 2019–2026"
      },
      "fpl_delta": { "prev_p_start": 0.86, "new_p_start": 0.12, "xp_change": -3.1 }
    }
  ]
}
```

Rules the frontend enforces:

- `decoded.p_start` renders **only** when `confidence != "insufficient"`.
- `decoded.basis` is always shown next to the number. A percentage with no
  visible sample count is not permitted anywhere in this section.
- `injury.severity_score` (0–100) is a *display ranking* of disruption, derived
  from `median_layoff_days` and position importance. It is never the headline —
  the layoff range in real days is, because "62" means nothing to a manager
  picking a team.

### 1.4 Severity model

`severity_score = f(median_layoff_days, minutes_share_lost, replacement_dropoff)`

Ranked bands, shown as words not just numbers: `knock` (0–7d) · `short`
(8–21d) · `medium` (22–56d) · `long` (57d+) · `season`.

---

## 2. Probabilistic Predicted Lineups

### 2.1 Shipped today

`minutes.estimate()` already derives, per player:

- `p_start` — decayed start rate × availability × congestion
- `p_60` — probability of reaching the 60-minute points threshold
- `exp_mins` — `p_start × mins_per_start + p_sub × 20`

These are now exported to the client as `ps`, `p60`, `xm` and rendered as
**confidence bars on every shirt plus a seven-man bench**, each with a start
percentage and an involvement band (Nailed / Likely / Rotation risk / Impact
sub). The bench excludes academy and fourth-choice players by design, with one
exception: the backup keeper is always named, because a real bench always
carries one.

### 2.2 Player payload

```json
{
  "player_id": 231,
  "name": "Saliba",
  "position": "DEF",
  "price": 6.5,
  "p_start": 0.88,
  "p_60": 0.85,
  "p_appearance": 0.91,
  "x_mins": 79.4,
  "band": "nailed",
  "rotation": {
    "risk": 0.14,
    "drivers": [
      { "kind": "european_fixture", "when": "UCL Tue", "effect": -0.09 },
      { "kind": "fixture_congestion", "games_in_days": [3, 8], "effect": -0.05 }
    ]
  },
  "sub_profile": { "p_sub_on": 0.03, "median_sub_minute": 71 },
  "minutes_flag": "",
  "provenance": "model"
}
```

`provenance` is load-bearing: `model` | `press_conference` | `manual_override`.
The UI must show which, because a 12% from a decoded quote and a 12% from the
minutes model are different kinds of claim.

### 2.3 Rotation risk

Risk is a **decomposition, not a score** — the drivers array is the point. "88%
to start" is useful; "88%, and the 12% is a Tuesday Champions League game" is
actionable. The existing model already carries `CONGESTION_PENALTY = 0.88`
applied per congested club; the driver list makes that visible rather than
silently baked in.

---

## 3. The Tactical Ripple Effect

### 3.1 What is derivable now

Two of the three requested ripples are computable from data already held:

- **Who starts instead** — the next player at that position by `p_start`, with
  price and projected points. Pure lookup.
- **Formation shift** — inferable from which positions retain cover. Needs a
  per-club shape prior to be good; a squad-shape heuristic ships first.

The third — **xP impact on teammates** — is the hard one and must not be faked.
"Son's xA drops 14% without Maddison" requires a with/without-player model fitted
on lineup-level data. What is defensible without it: clean-sheet probability
shifts, because the Dixon–Coles fixture model already produces a team defensive
rating and swapping a defender's contribution through it is a modelled quantity,
not a guess.

### 3.2 Ripple payload

```json
{
  "trigger": { "player_id": 231, "club": "ARS", "status": "out", "gw": 7 },
  "replacement": {
    "player_id": 402, "name": "Kiwior", "price": 4.5,
    "p_start_before": 0.11, "p_start_after": 0.79,
    "fpl_verdict": "Playable at 4.5 but the clean sheet is the reason, not him"
  },
  "shape": { "from": "4-3-3", "to": "4-3-3", "confidence": 0.72, "changed": false },
  "team_effects": [
    {
      "metric": "clean_sheet_probability",
      "before": 0.38, "after": 0.29, "delta_pct": -23.7,
      "method": "dixon_coles_defensive_rating_swap",
      "confidence": "medium"
    }
  ],
  "teammate_effects": [
    {
      "player_id": 118, "name": "Saka",
      "metric": "xA_per_90", "delta_pct": -6.2,
      "method": "with_without_lineup_model",
      "confidence": "low",
      "n_minutes_together": 1840
    }
  ]
}
```

Any `teammate_effects` entry with `confidence: "low"` renders as a **direction
with a caveat** ("slightly negative, thin sample"), never a decimal percentage.

---

## 4. UI blueprint

### 4.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Club switcher (20 crests, horizontal)                       │
├──────────────────────────────────────────────────────────────┤
│  CLUB HEADER — crest · next fixture · difficulty strip       │
│  ── Status line: "3 doubts · 1 out · presser 2h ago" ──      │
├───────────────────────────────┬──────────────────────────────┤
│  PREDICTED XI                 │  PRESS CONFERENCE DECODER    │
│  pitch, confidence bar under  │  quote card per player:      │
│  every shirt                  │   ▸ what he said             │
│                               │   ▸ what it has meant (n=34) │
│  LIKELY BENCH (7)             │   ▸ layoff range in days     │
│  name · bar · % · band        │                              │
├───────────────────────────────┼──────────────────────────────┤
│  ROTATION HEATMAP             │  RIPPLE EFFECT               │
│  players × next 5 GWs         │  only renders when something │
│  cell = P(start)              │  is actually flagged         │
└───────────────────────────────┴──────────────────────────────┘
```

Single column on mobile, in that order. The ripple panel is **conditional** —
an empty "no domino effects" card is noise.

### 4.2 Managing the density

The brief is "unbelievable depth" and the risk is an unreadable wall. Three
rules:

1. **One number per row is the headline; the rest is on demand.** Each player
   row shows name, start %, band. Injury history, sub profile and drivers live
   behind a tap.
2. **Silence is signal.** Rows for nailed, unflagged players are visually quiet;
   colour and weight are spent only on doubts and changes.
3. **Sort by what changed, not alphabetically.** After a presser the list
   reorders so movers are on top, with a "changed since Thursday" marker.

### 4.3 Visual indicators

| Element | Encoding | Why |
|---|---|---|
| Start chance | filled bar + printed % | never colour alone; number is the fallback |
| Involvement band | word chip (Nailed/Likely/Rotation risk) | text carries it for CVD and screen readers |
| Rotation heatmap | single-hue sequential ramp, light→dark | magnitude, so one hue — never a rainbow |
| Injury severity | 5 named bands + day range | "62/100" is meaningless; "out 11–26 days" is not |
| Confidence | sample count in text | a percentage without `n` is not shown at all |
| Changed since presser | left rule + timestamp | change is an event, not a colour |

The heatmap is the only true chart here and it is sequential-by-magnitude:
one hue, light→dark, with the percentage printed in each cell so the colour is
redundant rather than load-bearing.

---

## 5. Build order

1. **Ship the probabilistic lineups.** Done — real model output, no new data.
2. **Ripple: replacement + clean sheet.** Derivable from held data.
3. **Quote archive.** Ingest and display quotes with model context, no decoded
   percentages. Immediately useful, zero fabrication risk.
4. **Label the corpus.** The unglamorous prerequisite: resolve historical quotes
   against outcomes until managers clear `min_samples`.
5. **Turn on decoding, manager by manager,** as each passes calibration.
6. **Injury severity**, once injury-type-coded layoffs are sourced.

Steps 3–4 are the real cost of this section. Everything else is presentation.
