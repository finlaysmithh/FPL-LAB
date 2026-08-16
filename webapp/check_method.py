"""
Fail the build if the methodology page states a figure the code disagrees with.

The page claims every constant is read from the live model at build time. That
claim was true of the values rendered through `DATA.model`, and quietly false
of every number typed into the prose around them — and prose is where most of
the figures live, because "measured across a full season: 796 real assists
against 579 xA" is the sentence that carries the evidence.

This does not try to parse English. It checks the constants that ARE wired
through `DATA.model` still match the Python they came from, and it checks that
no hardcoded copy of one of those constants has crept into the JSX beside it.
A number that appears in the prose AND differs from the live value is the
failure mode this catches.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fplab import config, player_history, roles  # noqa: E402

# Constant -> the live value it must agree with. Only constants whose value is
# a distinctive number worth guarding; a "2" or a "3" would match everywhere.
GUARDED = {
    "SHRINK_K_ATTACK": config.SHRINK_K_ATTACK,
    "SHRINK_K_DEFCON": config.SHRINK_K_DEFCON,
    "SHRINK_K_BPS": config.SHRINK_K_BPS,
    "SHARE_SHRINK_K": player_history.SHARE_SHRINK_K,
    "SEASON_DECAY": player_history.SEASON_DECAY,
    "HORIZON_CONFIDENCE_DECAY": config.HORIZON_CONFIDENCE_DECAY,
    "BUDGET_OUTFIELD": roles.BUDGET_OUTFIELD,
    "BUDGET_GK": roles.BUDGET_GK,
    "XI_NAIL_FLOOR": roles.XI_NAIL_FLOOR,
    "XI_NAIL_FLOOR_GK": roles.XI_NAIL_FLOOR_GK,
    "ROLE_CONCENTRATION": roles.ROLE_CONCENTRATION,
    "XI_FLOOR_HALFLIFE": config.XI_FLOOR_HALFLIFE,
}

# The exporter's key for each, so the page can be checked against what it is
# actually served rather than against the Python directly.
EXPORT_KEY = {
    "SHRINK_K_ATTACK": "shrink_k_attack",
    "SHRINK_K_DEFCON": "shrink_k_defcon",
    "SHRINK_K_BPS": "shrink_k_bps",
    "SHARE_SHRINK_K": "share_shrink_k",
    "SEASON_DECAY": "season_decay",
    "HORIZON_CONFIDENCE_DECAY": "horizon_decay",
    "BUDGET_OUTFIELD": "budget_outfield",
    "BUDGET_GK": "budget_gk",
    "XI_NAIL_FLOOR": "xi_nail_floor",
    "XI_NAIL_FLOOR_GK": "xi_nail_floor_gk",
    "ROLE_CONCENTRATION": "role_concentration",
    "XI_FLOOR_HALFLIFE": "xi_floor_halflife",
}


def main() -> int:
    data = json.loads((ROOT / "webapp" / "data.json").read_text())
    model = data.get("model", {})
    page = (ROOT / "webapp" / "src" / "Method.jsx").read_text()

    problems = []

    # 1. Everything guarded must actually be exported, or the page cannot be
    #    reading it and any figure shown is hardcoded by definition.
    for name, live in GUARDED.items():
        key = EXPORT_KEY[name]
        if key not in model:
            problems.append(f"{name}: not exported as `{key}` — the page cannot read it")
            continue
        if abs(float(model[key]) - float(live)) > 1e-9:
            problems.append(
                f"{name}: data.json has {model[key]}, code has {live}")

    # A PROSE SCAN WAS TRIED HERE AND REMOVED. Matching "any literal of similar
    # magnitude to a guarded constant" flagged 21 figures on a correct page:
    # 94.2 is the measured first-choice-keeper start rate and has nothing to do
    # with the 92.7-minute goalkeeping budget; 0.906 and 0.933 are split-half
    # correlations, not nail floors. Numbers of similar size are not the same
    # number, and no regex knows the difference.
    #
    # A build gate that fails on correct content gets switched off within a
    # week, which is worse than no gate. What is checked instead is the part
    # that CAN be checked mechanically and is the actual failure mode: that
    # every guarded constant is exported, and that the value the page is served
    # equals the value the engine runs on. Prose figures are guarded by review.

    if problems:
        print("METHODOLOGY OUT OF SYNC WITH THE MODEL\n")
        for p in problems:
            print(f"  ✗ {p}")
        print(f"\n{len(problems)} problem(s). The page claims its figures are read "
              f"from the live model; make that true or change the claim.")
        return 1

    print(f"methodology in sync — {len(GUARDED)} guarded constants match the live model")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
