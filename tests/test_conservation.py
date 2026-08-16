"""
Conservation incidence: a bloated squad's surplus must come off the FRINGE.

Scaling a club to its minute budget is only correct if the cut lands where the
uncertainty is. A club that over-sums by 40% has not discovered that its
first-choice centre-half plays 40% less football — it has too many squad
players with plausible-looking estimates. Taking the trim proportionally from
everyone charges a nailed starter for the depth behind him.

The assertion is the one that matters in practice: at a 40% over-subscription,
a player at nailed = 0.95 should lose under 5% of his minutes.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import numpy as np, pandas as pd
from fplab import roles


def build_club(n_fringe: int, nailed_top: float = 0.95, mps: float = 88.0):
    """One certain starter plus a tail of plausible squad players."""
    names = ["NAILED"] + [f"fringe{i}" for i in range(n_fringe)]
    # Role score is minutes: the nailed man commands nearly a full match, the
    # fringe each command a middling share. Enough of them and the club
    # over-sums.
    role = [nailed_top * mps] + [0.55 * mps] * n_fringe
    pos = ["DEF"] + ["DEF"] * 4 + ["MID"] * 5 + ["FWD"] * 2 \
        + ["MID"] * max(0, n_fringe - 11)
    pos = pos[:n_fringe + 1]
    return pd.DataFrame({
        "name": names,
        "role": role,
        "team": ["XXX"] * (n_fringe + 1),
        "position": pos,
        "mps": [mps] * (n_fringe + 1),
    })


def incidence(n_fringe: int):
    df = build_club(n_fringe)
    unconstrained = df["role"].sum()
    over = unconstrained / roles.BUDGET_OUTFIELD
    alloc = roles.allocate(
        df["role"], df["team"], df["position"],
        mins_per_start=df["mps"],
        # A measured record, so the nailed player is protected by evidence
        # rather than by a predicted-XI naming.
        evidence_minutes=pd.Series([3200.0] + [900.0] * n_fringe),
        concentration=1.0,
    )
    got = alloc["exp_mins"].to_numpy()
    want_top = df["role"].iloc[0]
    loss = (want_top - got[0]) / want_top
    return over, loss, got[0], want_top, got.sum()


print("conservation incidence — where does the trim land?\n")
print(f"{'over-sub':>9s} {'nailed wanted':>14s} {'nailed got':>11s} {'loss':>7s} {'club total':>11s}")
worst = 0.0
for n in (12, 16, 20, 24, 26, 28, 32):
    over, loss, got, want, total = incidence(n)
    print(f"{over:8.2f}x {want:14.1f} {got:11.1f} {loss:6.1%} {total:11.1f}")
    if over >= 1.35:
        worst = max(worst, loss)

# The stated assertion, at 40%+ over-subscription. 26 fringe players puts the
# club at ~1.4x, which is the case the spec names.
N_OVER = 26
over, loss, got, want, total = incidence(N_OVER)
assert over >= 1.35, f"test club only over-subscribes {over:.2f}x — not exercising the case"
assert loss < 0.05, (
    f"a nailed 0.95 player lost {loss:.1%} of his minutes at {over:.2f}x "
    f"over-subscription; the surplus should come off the fringe")
print(f"\n[1] nailed player keeps his minutes   {loss:.2%} lost at {over:.2f}x OK")

# And the club still balances — the point of conservation in the first place.
assert abs(total - roles.BUDGET_OUTFIELD) < 1.0, f"club total {total:.1f}"
print(f"[2] club still balances to budget     {total:.1f} vs {roles.BUDGET_OUTFIELD} OK")

# The fringe, not the starter, absorbs it.
df = build_club(N_OVER)
alloc = roles.allocate(df["role"], df["team"], df["position"],
                       mins_per_start=df["mps"],
                       evidence_minutes=pd.Series([3200.0] + [900.0] * N_OVER),
                       concentration=1.0)
fringe_got = alloc["exp_mins"].to_numpy()[1:]
fringe_want = df["role"].to_numpy()[1:]
fringe_loss = (fringe_want.sum() - fringe_got.sum()) / fringe_want.sum()
assert fringe_loss > loss * 3, (
    f"fringe lost {fringe_loss:.1%} vs nailed {loss:.1%} — the trim is not "
    f"concentrated where the uncertainty is")
print(f"[3] fringe absorbs the surplus        fringe {fringe_loss:.1%} vs nailed {loss:.2%} OK")

print("\nALL CONSERVATION TESTS PASSED")
