# FPL Lab web app

A Vite + React app, Premier League-themed (official PL purple `#37003C`,
neon green `#00FF87`, Archivo + IBM Plex Mono). No Tailwind — the design
system lives in `src/styles.css`.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

## Data — real, from the model

The app imports `data.json` and `optimal.json` from this folder. As of
2026-08-06 these are **real**: all 567 registered 2026/27 players with real
prices, prior-season rates from vaastav/Fantasy-Premier-League, the
Dixon–Coles fixture model, penalty/minutes corrections, and MILP-solved
optimal squads (per-GW ×6, a 3-week held squad `h3`, and the 6-week `range`).

To refresh (from the project root):

```bash
python3 -m fplab.build_real     # rebuild dataset (~30s, hits GitHub archive)
python3 webapp/export_data.py   # re-solve optimals + rewrite the JSONs
```

`generate_sample.py` still exists for offline UI hacking only — running it
overwrites the real JSONs with fakes, so don't unless you mean to.

## Weekly team notes

`team-notes.json` is the one file in this app that is **yours**, not generated.
Everything on a club's Team News page except the free text — expected XI,
injury flags, penalty order, places under threat — is derived from real FPL
data and the model, and refreshes when you rerun the pipeline. Nothing in the
notes file is ever written or guessed by the model.

Per club: `headline`, `manager` (an actual quote, with a date), `watch`,
`penalties` (override the FPL order when you know better), `updated`. Leave a
field empty and the page omits it rather than showing a placeholder. Edit,
then `npm run build`.

## Structure

- `src/logic.js` — squad rules, best-XI/captain scoring, transfer engine,
  grading, localStorage persistence. UI-free.
- `src/kits.js` — club kit colours/patterns + display names.
- `src/components.jsx` — Jersey, Shirt card, `NextFixture` (this week's
  opponent + H/A, FPL style), `FixtureStrip` (six-week difficulty colours),
  GW picker, stat tiles, captain bar, score breakdown.

  Venue is encoded in the *case* of the opponent code in `data.json`
  (`COV` = home, `cov` = away), so there is no separate venue field —
  `fixtureAt()` in `logic.js` decodes it. Difficulty is never conveyed by
  colour alone: the pill always names the opponent in text, and the colour
  strip beneath it repeats what the pill already says.
- `src/Pitch.jsx` — the broadcast-style SVG pitch (markings, mow stripes,
  floodlight, grain) + bench dugout.
- `src/MarketPanel.jsx` — the transfer market: position tabs, search, sort,
  club and price filters, affordability/club-limit guards. Sits beside the
  pitch on desktop (so the squad stays visible while you shop) and inside
  `SwapSheet` on mobile — same component either way, so the interaction
  never changes shape.

  Every row carries an explicit **Swap in** button rather than being a bare
  clickable row: silently transferring on row-tap was the single most
  confusing thing in the old sheet. When a player is on the way out, each
  row is scored *against him* — the points and money that exact swap gains
  or costs — because that difference, not the absolute total, is the
  decision being made.

- `src/SwapSheet.jsx` — thin mobile wrapper that presents `MarketPanel`
  as a bottom sheet.
- `src/tabs.jsx` — the four views: My Squad (blank 15-slot builder → scored
  squad with manual captain + transfer recommendations), Optimal (per-GW /
  3-week-held toggle), Value, Fixtures.
- `src/App.jsx` — shell, header, bottom tab navigation.

`app.jsx` in this folder is the legacy single-file chat-artifact version
(`__DATA__`/`__OPTIMAL__` placeholders); the `src/` app supersedes it.

## Known follow-ups

- Multi-period transfer planning (free-transfer bank, hit-taking across
  weeks) exists in `fplab/optimize.py` but isn't wired in — the My Team
  suggestions are a single-swap greedy search.
- Real-squad import by FPL entry ID (`fplab.pipeline.import_squad`) would
  need a small backend.
