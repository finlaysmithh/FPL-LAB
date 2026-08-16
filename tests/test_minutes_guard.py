"""Minutes guard tests.

The fixture below is a synthetic *test* frame, never a product path — it exists
so each acceptance case is isolated and the thresholds are readable. The real
values these cases were drawn from are in the assertions' comments.

Run: python tests/test_minutes_guard.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import pandas as pd

from fplab import minutes as M
from fplab.config import MIN_EXPECTED_MINUTES

SEASON = 38 * 90


def row(name, pos, price, prior_minutes, new_signing=False):
    return {
        "name": name, "position": pos, "price": price,
        "prior_minutes": float(prior_minutes),
        "mins_share_prior": float(prior_minutes) / SEASON,
        "is_new_signing": new_signing,
    }


def build():
    """A pool wide enough that within-position price percentiles are meaningful."""
    rows = [
        # --- the acceptance cases -----------------------------------------
        row("Haaland-type", "FWD", 15.5, 2953),            # nailed, untouched
        row("Isak-type", "FWD", 9.0, 694),                 # injured starter
        row("Guiu-type", "FWD", 5.0, 265),                 # fringe, full season
        row("ThirdKeeper", "GK", 4.0, 0),                  # never played
        row("BigSigning", "FWD", 9.0, 0, new_signing=True),  # abroad, unknown
        # --- context so the percentile ranks are real ---------------------
        *[row(f"fwd{p}", "FWD", p, 2200) for p in (4.5, 5.5, 6.0, 6.5, 7.0,
                                                   7.5, 8.0, 8.5, 10.0, 12.0)],
        *[row(f"gk{i}", "GK", p, 2800) for i, p in enumerate(
            (4.0, 4.5, 4.5, 5.0, 5.0, 5.5, 5.5, 6.0))],
        *[row(f"gkres{i}", "GK", 4.0, 0) for i in range(8)],
        *[row(f"def{p}", "DEF", p, 2500) for p in (4.0, 4.5, 5.0, 5.5, 6.0, 6.5)],
        *[row(f"mid{p}", "MID", p, 2500) for p in (4.5, 5.0, 6.0, 7.0, 8.0, 9.0)],
    ]
    df = pd.DataFrame(rows)
    df.index = df["name"]
    return df


def main():
    df = build()
    g = M.minutes_guard(df)
    out = g.join(df[["position", "price", "prior_minutes"]])

    def case(name):
        return out.loc[name]

    fails = []

    def check(label, cond, detail):
        status = "OK  " if cond else "FAIL"
        print(f"[{status}] {label}: {detail}")
        if not cond:
            fails.append(label)

    print(f"minutes gate = {MIN_EXPECTED_MINUTES:.0f} xMins/game\n")

    # 1. Haaland-type: 2,953 real minutes. No ceiling may bind.
    h = case("Haaland-type")
    check("haaland untouched",
          h.minutes_ceiling == 1.0 and abs(h.mins_share - h.mins_share_raw) < 1e-9,
          f"share {h.mins_share:.3f} (raw {h.mins_share_raw:.3f}), "
          f"ceiling {h.minutes_ceiling:.2f}, {h.exp_mins:.0f} mins, flag '{h.minutes_flag}'")

    # 2. Isak-type: 694 mins at £9.0m. README argues ~0.46; the guard must not
    #    undo that — 694 is under the 1200 fringe threshold, so the ceiling is
    #    computed, but a £9.0m forward's price percentile must keep it above.
    i = case("Isak-type")
    check("isak preserved", i.mins_share >= 0.40,
          f"share {i.mins_share:.3f} (raw {i.mins_share_raw:.3f}), "
          f"ceiling {i.minutes_ceiling:.2f}, {i.exp_mins:.0f} mins, flag '{i.minutes_flag}'")

    # 3. Guiu-type: ~265 mins across a full season of availability at £5.0m.
    #    Must land under the gate.
    gu = case("Guiu-type")
    check("guiu gated", gu.exp_mins < MIN_EXPECTED_MINUTES,
          f"share {gu.mins_share:.3f} (raw {gu.mins_share_raw:.3f}), "
          f"ceiling {gu.minutes_ceiling:.2f}, {gu.exp_mins:.1f} mins, flag '{gu.minutes_flag}'")
    check("guiu flagged fringe", gu.minutes_flag == "fringe", f"'{gu.minutes_flag}'")

    # 4. Zero-minute £4.0m third-choice keeper.
    k = case("ThirdKeeper")
    check("third keeper gated", k.exp_mins < MIN_EXPECTED_MINUTES,
          f"share {k.mins_share:.3f} (raw {k.mins_share_raw:.3f}), "
          f"ceiling {k.minutes_ceiling:.2f}, {k.exp_mins:.1f} mins, flag '{k.minutes_flag}'")

    # 5. £9.0m new signing, zero PL history. THE regression that matters —
    #    the asterisk players must survive.
    s = case("BigSigning")
    check("new signing kept", s.exp_mins >= 40,
          f"share {s.mins_share:.3f}, ceiling {s.minutes_ceiling:.2f}, "
          f"{s.exp_mins:.0f} mins, flag '{s.minutes_flag}'")
    check("new signing flagged", s.minutes_flag == "new_signing_price_proxy",
          f"'{s.minutes_flag}'")

    # 6. Routing: a new signing WITH real PL minutes is not a new signing here.
    df2 = df.copy()
    df2.loc["Guiu-type", "is_new_signing"] = True   # 265 mins => still fringe
    g2 = M.minutes_guard(df2)
    check("evidence beats the signing label",
          g2.at["Guiu-type", "minutes_flag"] == "fringe",
          f"'{g2.at['Guiu-type', 'minutes_flag']}' with 265 prior mins")

    print()
    if fails:
        print("FAILED:", ", ".join(fails))
        sys.exit(1)
    print("ALL MINUTES GUARD TESTS PASSED")


if __name__ == "__main__":
    main()
