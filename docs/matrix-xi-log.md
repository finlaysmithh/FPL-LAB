# The Matrix XI — decision log

The model's own FPL team, entered for real and managed in public. Each entry
records what the engine said at the deadline, with the data it was run on, so
the calls can be checked against what actually happened.

## GW4 — deadline Sat 12 Sep 2026, 12:30 UTC

**Data.** Archived registry through GW1 (vaastav mirror; the live FPL API is
not reachable from the build sandbox), prior-season rates, plus hand-entered
deadline-day club moves in `data/overrides.csv`: Enzo Fernández and Iliman
Ndiaye to Man City, Grealish back to Everton, Gabriel Jesus to Barcelona.
GW2–3 results were checked by hand; player-level GW2–3 stats are not yet in
the model.

**Squad held since GW1** (no transfers made in GW2 or GW3, three free
transfers banked): Verbruggen, Leno; Gabriel, Van Dijk, Thiaw, Guéhi,
Tarkowski; Bruno Fernandes, Anderson, Enzo, Ndiaye, Groß; Isak, Thiago,
McBurnie. £0.0m in the bank.

**Forced issue.** Enzo and Ndiaye both joined Man City on 1 September, so the
squad holds four City players with Guéhi and Anderson. Ndiaye projects 23
minutes a game in City's rotating front line; Enzo started and is treated as
a first-choice midfielder (0.80 minutes share, hand-set).

**Six-gameweek MILP, GW4–9, no hits, from the held squad:**

| Plan | FTs used | xP GW4–9 |
|---|---|---|
| Ndiaye → Garner, Thiago → João Pedro | 2 | 272.3 |
| Enzo, Ndiaye, McBurnie → Barkley, João Pedro, Garner | 3 | 272.7 |
| Thiago, Enzo, Ndiaye → Rogers, João Pedro, Garner | 3 | 272.5 |
| Ndiaye → Garner only | 1 | 270.9 |

The spread is under two points across six weeks, which is noise. The
two-transfer plan sits at the top, keeps a free transfer in hand and keeps
Enzo, so it is the call.

**Transfers:** Ndiaye → Garner (EVE, £6.0m). Thiago → João Pedro (CHE, £7.6m).
Third free transfer banked (two available for GW5).

**XI (3-5-2):** Verbruggen; Gabriel, Van Dijk, Tarkowski; Bruno Fernandes,
Anderson, Enzo, Garner, Groß; Isak, João Pedro.
**Bench:** Leno; Thiaw, Guéhi, McBurnie.

**Captain:** Isak (5.43 xP, home to Fulham, brace at Ipswich in GW3).
Vice: João Pedro (5.47 xP, home to Hull). The model has the two level; Hull
have not conceded in three matches, which the promoted-side prior cannot see,
and that breaks the tie toward Isak.

**Chips:** none. No double or blank gameweek in GW4–9; the chip solver places
Bench Boost and Triple Captain arbitrarily, which is the signature of no
standout week. First Triple Captain fixture worth watching: Haaland at home
to Ipswich in GW7.
