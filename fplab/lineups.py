"""
Predicted starting XIs as a minutes floor for players the model cannot rank.

The minutes model is good at players it has watched and blind to players it has
not. For a promoted club it has watched nobody: Ipswich's twenty-nine
registered players share one price-implied prior between them, so the model
ranks them all equal and the conservation step in `fplab.roles` divides 922
minutes twenty-nine ways. Thirty-two minutes each is an honest statement of
ignorance and a useless projection — and it is the direct cause of a squad of
promoted-club enablers projecting in the fifties.

`data/predicted_xi.csv` supplies the missing rank. This module applies it, with
two deliberate restrictions.

**It only floors, never caps.** A player named in a predicted XI is lifted to
`XI_MINUTES_SHARE` if the model had him lower. A player left out is not
demoted — a pre-season XI prediction is not evidence that the twelfth man never
plays, and conservation already pushes the rest of the squad down once eleven
players are raised.

**Here it only touches players the model is uninformed about.** A pundit's
pre-season guess is worse evidence than a season of measured minutes, so an
established player's own *rate* is left alone. The gate is `no_pl_history`, a
fringe/new-signing minutes flag, or simply having played too little last season
to be judged.

Being named still counts for everyone, but it counts in the right place:
`roles.allocate` floors the PICK PROBABILITY of every named starter at the
measured rate for a first-choice player (74.2% outfield, 94.2% in goal). That
is where selection information belongs, because the failure it prevents is a
conservation failure — a thirty-man squad diluting a guaranteed starter to fund
nine rotation forwards. The two mechanisms answer different questions: this
file says "the model has no idea what this player's role is, here is one", and
the nail floor says "whatever his rate, this player gets picked".

The 0.82 share floor here is deliberately short of 1.0 because it is a
prediction about one gameweek being used as a season-long role estimate. A
player who really is nailed will be carried above it by conservation anyway
once his club's budget has to balance; a player wrongly named costs less when
the claim is modest.
"""
from __future__ import annotations

import unicodedata

import pandas as pd

from .sources import DATA

XI_MINUTES_SHARE = 0.82

# Below this many prior-season minutes the model has no real view of a player's
# role, so a predicted XI is better information than what it holds.
UNINFORMED_MINUTES = 900.0

UNINFORMED_FLAGS = {"fringe", "new_signing_price_proxy"}


def _key(s: str) -> str:
    """Fold accents and case so 'Gyökeres' matches 'Gyokeres'."""
    txt = unicodedata.normalize("NFKD", str(s))
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    return txt.strip().lower()


def load() -> pd.DataFrame | None:
    path = DATA / "predicted_xi.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path, comment="#")
    df["_k"] = df["web_name"].map(_key)
    return df


def apply_xi_floor(players: pd.DataFrame,
                   share: float = XI_MINUTES_SHARE) -> tuple[pd.DataFrame, dict]:
    """
    Floor predicted starters who the model has no basis to rank.

    Returns the frame plus a report: how many rows matched, how many were
    actually lifted, and any XI entries that matched no registered player —
    which is the signal that the file has gone stale and needs re-reading.
    """
    xi = load()
    if xi is None:
        return players, {"matched": 0, "lifted": 0, "unmatched": []}

    df = players.copy()
    df["_k"] = df["web_name"].map(_key)
    df["predicted_xi"] = False

    mins = pd.to_numeric(df.get("prior_minutes", 0), errors="coerce").fillna(0.0)
    flag = df.get("minutes_flag", pd.Series("", index=df.index)).fillna("")
    uninformed = (mins < UNINFORMED_MINUTES) | flag.isin(UNINFORMED_FLAGS)

    matched, lifted, unmatched = 0, 0, []
    for _, row in xi.iterrows():
        hit = (df["team"] == row["team"]) & (df["_k"] == row["_k"])
        if not hit.any():
            unmatched.append(f"{row['team']}/{row['web_name']}")
            continue
        matched += int(hit.sum())
        df.loc[hit, "predicted_xi"] = True
        target = hit & uninformed & (df["mins_share_prior"] < share)
        if target.any():
            df.loc[target, "mins_share_prior"] = share
            df.loc[target, "minutes_flag"] = "predicted_xi"
            lifted += int(target.sum())

    return df.drop(columns="_k"), {
        "matched": matched, "lifted": lifted, "unmatched": unmatched,
    }
