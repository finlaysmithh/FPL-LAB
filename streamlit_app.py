"""
FPL Lab — real-data Streamlit UI.

    python -m fplab.build --season 2026 --prior-season 2025
    streamlit run app.py

There is no demo mode. If the dataset has not been built, the app tells you to
build it rather than showing invented numbers.
"""
from __future__ import annotations

import json

import pandas as pd
import streamlit as st

from fplab import pipeline, sources
from fplab.config import BUDGET, MIN_EXPECTED_MINUTES
from fplab.sources import DATA

st.set_page_config(page_title="FPL Lab", layout="wide", page_icon="⚽")

# `layout="wide"` alone still leaves Streamlit's own max-width on
# .block-container, which is why this rendered as a narrow column on a laptop.
st.markdown("""
<style>
  .block-container { padding: 1rem 1rem 3rem; }
  @media (min-width: 992px) {
    .block-container { max-width: 1600px; padding: 1.5rem 2.5rem 3rem; }
  }
  /* Let the tab row wrap instead of clipping the later tabs. */
  .stTabs [data-baseweb="tab-list"] { flex-wrap: wrap; gap: 2px; }
  /* Tables should use the width they are given. */
  .stDataFrame, [data-testid="stDataFrame"] { width: 100% !important; }
</style>
""", unsafe_allow_html=True)

st.title("⚽ FPL Lab")
st.caption("Real FPL + Understat data · dual fixture difficulty · multi-period MILP optimiser")


@st.cache_data(ttl=1800)
def load():
    return pipeline.load()


try:
    players, matchlog, fixtures = load()
except FileNotFoundError as e:
    st.error(str(e))
    st.code("python -m fplab.build_real", language="bash")
    st.stop()

audit = json.loads((DATA / "audit.json").read_text()) if (DATA / "audit.json").exists() else {}

with st.sidebar:
    st.header("Plan")
    mode = st.radio("Mode", ["Wildcard / fresh build", "Weekly transfer", "Horizon plan"])
    start_gw = st.number_input("Start GW", 1, 38, int(audit.get("current_gw", 1)))
    n_gws = st.slider("Gameweeks", 1, 12, 1 if mode == "Weekly transfer" else 6)
    budget = st.number_input("Budget £m", 80.0, 130.0, BUDGET, 0.1)

    st.divider()
    st.subheader("Your team")
    entry_id = st.text_input("FPL team ID (optional)",
                             help="From your FPL URL: /entry/XXXXXX/")
    current_squad, bank = None, 0.0
    if entry_id.strip().isdigit() and mode != "Wildcard / fresh build":
        try:
            current_squad, bank, _ = pipeline.import_squad(int(entry_id))
            st.success(f"Imported {len(current_squad)} players · £{bank:.1f}m bank")
        except Exception as ex:
            st.warning(f"Could not import: {ex}")

    free_transfers = st.slider("Free transfers", 0, 5, 1)
    max_hits = st.slider("Max hits allowed (-4 each)", 0, 4, 0)
    wc = st.checkbox("Play wildcard in this range")
    wildcard_gw = st.number_input("Wildcard GW", start_gw, start_gw + n_gws - 1,
                                  start_gw) if wc else None

    st.divider()
    st.subheader("Customise")
    names = players.sort_values("price", ascending=False)
    label = names.apply(lambda r: f"{r['web_name']} ({r['team']} {r['position']} "
                                  f"£{r['price']}m)", axis=1)
    lookup = dict(zip(label, names["fpl_id"]))
    must_in = st.multiselect("Must include", list(lookup), max_selections=15)
    must_out = st.multiselect("Must exclude", list(lookup))
    max_own = st.slider("Max ownership % (differentials)", 0, 100, 100)
    max_club = st.slider("Max per club", 1, 3, 3)
    min_minutes = st.slider(
        "Minimum expected minutes/game", 0, 60, int(MIN_EXPECTED_MINUTES),
        help="Players projected below this cannot hold a squad slot. "
             "must_include always overrides it.")
    n_alts = st.slider("Alternative squads", 0, 5, 3)

gws = list(range(int(start_gw), int(start_gw) + int(n_gws)))

with st.spinner("Projecting…"):
    proj, ratings_df, ftab = pipeline.build_projections(players, matchlog, fixtures, gws)

res = pipeline.plan(
    proj, gws,
    budget=budget, bank=bank,
    current_squad=current_squad if mode != "Wildcard / fresh build" else None,
    free_transfers=free_transfers,
    max_hits_total=max_hits,
    wildcard_gw=int(wildcard_gw) if wildcard_gw else None,
    must_include=[lookup[n] for n in must_in],
    must_exclude=[lookup[n] for n in must_out],
    max_per_club=max_club,
    max_ownership=float(max_own) if max_own < 100 else None,
    min_expected_minutes=float(min_minutes),
    n_alternatives=n_alts,
)
best = res["best"]

if best["status"] != "Optimal":
    st.error(f"No legal squad found — {best['status']}")
    st.warning(best.get("diagnosis", ""))
    st.stop()

t1, t2, t3, t4, t7, t6, t5 = st.tabs(
    ["Squad", "Transfer plan", "Player projections", "Fixture ticker",
     "Minutes guard", "Penalties & model", "Data audit"])

with t1:
    c = st.columns(4)
    c[0].metric("Projected points", f"{best['objective']:.1f}")
    c[1].metric("Squad cost", f"£{best['weeks'][0]['cost']:.1f}m")
    c[2].metric("In the bank", f"£{budget + bank - best['weeks'][0]['cost']:.1f}m")
    c[3].metric("Hits taken", f"-{best['total_hits'] * 4}")
    st.dataframe(pipeline.squad_table(best, gws), use_container_width=True, hide_index=True)
    st.caption("* = projection still leaning on a previous club's data. "
               "Penalty takers carry explicit pen xG; unlisted players get zero.")

    if res["alternatives"]:
        st.subheader("Alternative squads")
        st.caption("A squad 1 point worse sharing only 10 players is often the "
                   "better rank play.")
        st.table(pd.DataFrame([
            {"Rank": i + 2, "xP gap": a["gap"], "Shared with optimum": a["overlap"],
             "Cost": a["weeks"][0]["cost"]}
            for i, a in enumerate(res["alternatives"])]))

with t2:
    st.dataframe(pipeline.transfer_plan(best), use_container_width=True, hide_index=True)
    st.caption("Free transfers bank up to 5. A blank row means rolling is optimal.")

with t3:
    pos = st.multiselect("Position", ["GK", "DEF", "MID", "FWD"],
                         default=["GK", "DEF", "MID", "FWD"])
    s = (proj[proj["position"].isin(pos)]
         .groupby(["fpl_id", "display_name", "team", "position", "price", "ownership"],
                  as_index=False).agg(xP=("xp", "sum")))
    s["xP per £m"] = (s["xP"] / s["price"]).round(2)
    if "exp_mins" in proj.columns:
        xm = proj.drop_duplicates("fpl_id").set_index("fpl_id")["exp_mins"]
        s["xMins/game"] = s["fpl_id"].map(xm).round(0)
    st.dataframe(s.sort_values("xP", ascending=False).head(80),
                 use_container_width=True, hide_index=True)
    st.caption("xMins/game is the expected minutes the points model actually "
               f"used. Players under {min_minutes:.0f} are excluded from the "
               "optimiser — see the Minutes guard tab.")

with t4:
    st.caption("Two ratings per fixture. Official FPL collapses attacking and "
               "defensive difficulty into one integer — its biggest flaw.")
    which = st.radio("Show", ["Attacking difficulty", "Defensive difficulty"],
                     horizontal=True)
    col = "fdr_attack" if which.startswith("Att") else "fdr_defence"
    tick = ftab[ftab.gw.isin(gws)].pivot_table(index="team", columns="gw", values=col)
    st.dataframe(tick.style.background_gradient(cmap="RdYlGn_r", axis=None).format("{:.1f}"),
                 use_container_width=True)

with t7:
    st.caption(
        "Two ceilings, not one flat cap. A player who had a Premier League "
        "season available and barely played is **evidence**, and gets shrunk "
        "toward what he actually did (`fringe`). A genuine new arrival has "
        "**unknown** minutes, so he is shrunk toward what his price implies "
        "(`new_signing_price_proxy`) — foreign-league minutes are not reachable "
        "from here, so price is the honest proxy. Both ceilings scale with "
        "price percentile *within position*."
    )
    cols = [c for c in ["display_name", "team", "position", "price",
                        "prior_minutes", "mins_share_raw", "minutes_ceiling",
                        "mins_share_prior", "exp_mins", "minutes_flag"]
            if c in players.columns]
    mg = players[cols].copy()
    cut = mg[mg["minutes_flag"].astype(str) != ""] if "minutes_flag" in mg else mg
    gated = cut[cut["exp_mins"] < min_minutes] if "exp_mins" in cut else cut

    c = st.columns(3)
    c[0].metric("Players capped", len(cut))
    c[1].metric(f"Below {min_minutes:.0f} xMins (gated)", len(gated))
    c[2].metric("Squad pool", f"{len(players) - len(gated)}")

    only_gated = st.checkbox("Show only players excluded by the gate", value=False)
    show = gated if only_gated else cut
    st.dataframe(
        show.sort_values("exp_mins").rename(columns={
            "display_name": "Player", "team": "Team", "position": "Pos",
            "price": "£m", "prior_minutes": "Prior mins",
            "mins_share_raw": "Raw share", "minutes_ceiling": "Ceiling",
            "mins_share_prior": "Final share", "exp_mins": "xMins/game",
            "minutes_flag": "Flag"}).round(3),
        use_container_width=True, hide_index=True)
    st.caption(
        "`clear_first_choice_gk` is the opposite correction: a club's single "
        "highest-priced keeper with a real record is floored at the fitted "
        "fit-keeper share, so an injury-shortened season does not push a "
        "nailed #1 below a backup."
    )

with t6:
    st.subheader("Penalty takers")
    st.caption("Order comes from FPL's real `penalties_order` field. A player "
               "with no listed order receives ZERO penalty xG — no guessing, "
               "no splitting penalties across a team's forwards.")
    if "pen_order" in players.columns:
        pk = players[players["pen_order"].notna()][
            ["web_name", "team", "position", "price", "pen_order",
             "pen_xg90_now", "npxg90_prior", "xg90_prior"]]
        st.dataframe(pk.sort_values(["team", "pen_order"]).round(3),
                     use_container_width=True, hide_index=True)
    st.divider()
    st.subheader("Backtest — real 2025/26, walk-forward")
    bt = DATA / "backtest_results.csv"
    if bt.exists():
        r = pd.read_csv(bt)
        c = st.columns(4)
        c[0].metric("MAE", f"{r['mae'].mean():.2f} pts")
        c[1].metric("Spearman", f"{r['spearman'].mean():.3f}")
        c[2].metric("Top-20 avg", f"{r['top_n_actual'].mean():.2f}")
        c[3].metric("Field avg", f"{r['field_mean'].mean():.2f}")
        st.line_chart(r.set_index("gw")[["spearman"]])
    fc = DATA / "fitted_coefficients.csv"
    if fc.exists():
        st.write("**Fitted standardised coefficients** — larger absolute value "
                 "means the signal moves points more.")
        st.dataframe(pd.read_csv(fc), use_container_width=True, hide_index=True)
    else:
        st.info("Run `python -m fplab.backtest` to generate these.")

with t5:
    st.caption("Trust nothing until this tab is clean.")
    c = st.columns(3)
    c[0].metric("Players loaded", audit.get("n_players", len(players)))
    c[1].metric("New signings flagged", audit.get("new_signings", "—"))
    c[2].metric("Unmatched regulars", len(audit.get("unmatched_regulars", [])))
    if audit.get("unresolved_fields"):
        st.error(f"Unresolved API fields: {audit['unresolved_fields']} — "
                 f"add the new key to FIELD_CANDIDATES in sources.py")
    st.write("**Name-match methods**")
    st.json(audit.get("match_methods", {}))
    if audit.get("unmatched_regulars"):
        st.write("**Unmatched players with real minutes** — add these to data/name_map.csv")
        st.dataframe(pd.DataFrame(audit["unmatched_regulars"]), hide_index=True)
