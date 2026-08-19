import React, { useCallback, useEffect, useState } from "react";
import { DATA, QUOTA, byId, clubCounts, storage, useIsWide } from "./logic.js";
import { canEditSquad, isSignedIn, signIn, signOut, useEntitlement } from "./entitlement.js";
import { SwapSheet } from "./SwapSheet.jsx";
import { SquadTab, ValueTab } from "./tabs.jsx";
import { OptimalTab } from "./Optimal.jsx";
import { FixturesTab } from "./Fixtures.jsx";
import { TeamNewsTab } from "./TeamNews.jsx";
import { PlayerChartsTab } from "./PlayerCharts.jsx";
import { MatrixXITab } from "./MatrixXI.jsx";
import { MethodTab } from "./Method.jsx";

const ICONS = {
  squad: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3 3 6l2 4 2-1v11h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0Z" />
    </svg>
  ),
  best: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z" />
      <path d="M9 6V4h6v2" />
      <path d="m8.5 12.5 2.2 2.2 4.8-4.8" />
    </svg>
  ),
  optimal: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12v4a6 6 0 0 1-12 0V3Z" />
      <path d="M6 5H3.5a0 0 0 0 0 0 0c0 3 1.5 5 4 5.5M18 5h2.5c0 3-1.5 5-4 5.5" />
      <path d="M12 13v3m-4 5h8m-6.5-5h5l1 5h-7l1-5Z" />
    </svg>
  ),
  value: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 12l9 9 9-9-9-9Z" />
      <path d="M14.5 9.5c-.4-.8-1.3-1.3-2.3-1.3-1.4 0-2.5.9-2.5 2s1 1.7 2.5 2 2.7.9 2.7 2.1-1.2 2-2.7 2c-1.1 0-2-.5-2.4-1.3M12 7v1.2M12 16v1.2" />
    </svg>
  ),
  fixtures: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18M8 15h3M13 15h3M8 18h3" />
    </svg>
  ),
  charts: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V4" /><path d="M4 20h16" />
      <rect x="7.5" y="12" width="3" height="5" rx="1" />
      <rect x="12.5" y="8" width="3" height="9" rx="1" />
      <rect x="17.5" y="5" width="3" height="12" rx="1" />
    </svg>
  ),
  news: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h12a1 1 0 0 1 1 1v13H5a1 1 0 0 1-1-1Z" />
      <path d="M17 9h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2" />
      <path d="M7 9h6M7 12.5h6M7 16h4" />
    </svg>
  ),
  matrix: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M3 12h18" opacity=".35" />
      <circle cx="12" cy="12" r="3.2" />
      <circle cx="6" cy="6" r="1.6" /><circle cx="18" cy="6" r="1.6" />
      <circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="18" r="1.6" />
    </svg>
  ),
  method: (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h3.5M8 16h5" />
      <path d="M15.5 12.5 18 15l-2.5 2.5" />
    </svg>
  ),
};

const TABS = [
  ["squad", "My Squad"],
  ["optimal", "Optimal"],
  ["value", "Value"],
  ["fixtures", "Fixtures"],
  ["news", "Team news"],
  ["charts", "Player charts"],
  ["matrix", "Matrix XI"],
  ["method", "Method"],
];

function Wordmark() {
  return (
    <div className="wordmark">
      <svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
        <defs>
          <linearGradient id="ballg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#00FF87" />
            <stop offset="1" stopColor="#04F5FF" />
          </linearGradient>
        </defs>
        <circle cx="17" cy="17" r="15" fill="none" stroke="url(#ballg)" strokeWidth="2.4" />
        <path d="M17 9.5 24 14.5 21.3 22.5 12.7 22.5 10 14.5 Z"
          fill="url(#ballg)" opacity="0.95" />
        <path d="M17 4.5V9.5M24 14.5l4.5-2M21.3 22.5l2.8 4M12.7 22.5l-2.8 4M10 14.5l-4.5-2"
          stroke="url(#ballg)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <div>
        <div className="wordmark-text">FPL <em>MATRIX</em></div>
        <div className="wordmark-sub">Squad optimiser</div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("squad");
  const [gi, setGi] = useState(0);
  const [squad, setSquad] = useState([]);
  const [capt, setCapt] = useState(null);
  const [swap, setSwap] = useState(null);
  const [side, setSide] = useState("plan");
  const [loaded, setLoaded] = useState(false);
  const wide = useIsWide();
  const [railOpen, setRailOpen] = useState(
    () => localStorage.getItem("fpllab:rail") !== "0");
  const toggleRail = useCallback(() => {
    setRailOpen((v) => { localStorage.setItem("fpllab:rail", v ? "0" : "1"); return !v; });
  }, []);
  const [psDismissed, setPsDismissed] = useState(
    () => localStorage.getItem("fpllab:ps_dismissed") === "1");

  const ent = useEntitlement();

  // ---- squad persistence, keyed to sign-in --------------------------------
  //
  // A SAVED team belongs to an account; an anonymous visitor starts blank on
  // every visit. Anonymous edits go to sessionStorage rather than nowhere, so
  // a refresh mid-build does not destroy fifteen picks — the team is blank
  // "every time you come back", not "every time the page hiccups". Signing in
  // is what promotes the team to durable storage; Clear squad is what removes
  // it. When real accounts exist this split survives: the durable half moves
  // behind the API and the anonymous half stays exactly this.
  useEffect(() => {
    (async () => {
      try {
        if (isSignedIn()) {
          const s = await storage.get("my_squad");
          if (s?.value) {
            const ids = JSON.parse(s.value);
            if (Array.isArray(ids)) setSquad(ids.filter((i) => byId[i]));
          }
          const c = await storage.get("capt");
          if (c?.value) setCapt(JSON.parse(c.value));
        } else {
          const s = sessionStorage.getItem("fpllab:session_squad");
          if (s) {
            const ids = JSON.parse(s);
            if (Array.isArray(ids)) setSquad(ids.filter((i) => byId[i]));
          }
          const c = sessionStorage.getItem("fpllab:session_capt");
          if (c) setCapt(JSON.parse(c));
        }
      } catch (e) { /* nothing saved yet */ }
      setLoaded(true);
    })();
  }, []);

  const saveSquad = useCallback(async (ids) => {
    setSquad(ids);
    try {
      if (isSignedIn()) await storage.set("my_squad", JSON.stringify(ids));
      else sessionStorage.setItem("fpllab:session_squad", JSON.stringify(ids));
    } catch (e) {}
  }, []);
  const saveCapt = useCallback(async (id) => {
    setCapt(id);
    try {
      if (isSignedIn()) await storage.set("capt", JSON.stringify(id));
      else sessionStorage.setItem("fpllab:session_capt", JSON.stringify(id));
    } catch (e) {}
  }, []);

  // Signing in keeps whatever is on screen: a draft in progress is the thing
  // the user is signing in to save, so it wins over an older stored team —
  // unless the screen is empty, in which case the stored team comes back.
  const handleSignIn = useCallback(async () => {
    const email = window.prompt(
      "Sign in with your email to keep your team saved between visits:");
    if (email == null) return;
    if (!/\S+@\S+\.\S+/.test(email.trim())) {
      window.alert("That doesn't look like an email address.");
      return;
    }
    signIn(email.trim());
    try {
      // A locked account's saved team wins over an anonymous draft — signing
      // out to rebuild and signing back in must not overwrite the squad the
      // free rating froze.
      if (squad.length > 0 && canEditSquad()) {
        await storage.set("my_squad", JSON.stringify(squad));
        await storage.set("capt", JSON.stringify(capt));
      } else {
        const s = await storage.get("my_squad");
        if (s?.value) {
          const ids = JSON.parse(s.value);
          if (Array.isArray(ids)) setSquad(ids.filter((i) => byId[i]));
        }
        const c = await storage.get("capt");
        if (c?.value) setCapt(JSON.parse(c.value));
      }
    } catch (e) {}
  }, [squad, capt]);

  // Signing out leaves the saved team in place for the next sign-in and
  // returns the page to the anonymous state: blank.
  const handleSignOut = useCallback(() => {
    if (!window.confirm(
      "Sign out? Your saved team stays on your account — this page goes back to blank.")) return;
    signOut();
    try {
      sessionStorage.removeItem("fpllab:session_squad");
      sessionStorage.removeItem("fpllab:session_capt");
    } catch (e) {}
    setSquad([]);
    setCapt(null);
  }, []);

  // Opening the market: on a wide screen the panel is already beside the pitch,
  // so we just point it at the right position; on a phone it comes up as a sheet.
  const openMarket = useCallback((m) => {
    setSwap(m);
    if (wide) setSide("market");
  }, [wide]);

  const setMarketPos = useCallback((pos) => {
    // Changing position abandons the replacement — you cannot swap a midfielder
    // for a defender, so pretending otherwise would only mislead.
    setSwap((s) => (s && byId[s.out]?.p === pos ? s : { pos, out: null }));
  }, []);

  const swapIn = useCallback((id) => {
    // Free-tier lock: once the one free rating is spent the squad is frozen.
    // The Squad tab explains why; this guard covers the mobile swap sheet and
    // the builder path, which write through here rather than editSquad.
    if (!canEditSquad()) { setSwap(null); return; }
    const m = swap;
    if (m?.out != null) {
      saveSquad(squad.map((x) => (x === m.out ? id : x)));
      if (capt === m.out) saveCapt(null);
      setSwap({ pos: m.pos, out: null });
    } else {
      const p = byId[id];
      const have = squad.map((i) => byId[i]).filter(Boolean);
      if (have.filter((q) => q.p === p.p).length >= QUOTA[p.p]) return;
      if ((clubCounts(squad)[p.t] || 0) >= 3) return;
      saveSquad([...squad, id]);
    }
    if (!wide) setSwap(null);
  }, [swap, squad, capt, wide, saveSquad, saveCapt]);

  const useSquad = useCallback((ids) => {
    if (!canEditSquad()) {
      window.alert("Your free team rating has been used, so your squad is "
        + "locked — replacing it is a Premium feature.");
      return;
    }
    if (squad.length > 0 &&
        !window.confirm("Replace your current squad with this one?")) return;
    saveSquad([...ids]);
    saveCapt(null);
    // The season plan belonged to the squad being replaced. Carrying its
    // transfers over to a different fifteen is what produced a 26-transfer,
    // 96-point-hit plan out of nowhere — so importing a squad starts clean.
    try { localStorage.removeItem("fpllab:plan"); } catch (e) {}
    setTab("squad");
    window.scrollTo({ top: 0 });
  }, [squad, saveSquad, saveCapt]);

  return (
    <div className={`shell ${railOpen ? "" : "rail-closed"}`}>
      <header className="top">
        <div className="top-row">
          <button className="rail-toggle" onClick={toggleRail}
            aria-label={railOpen ? "Hide the menu" : "Show the menu"}
            aria-expanded={railOpen} title={railOpen ? "Hide menu" : "Show menu"}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round">
              {railOpen
                ? <><path d="M15 5 8 12l7 7" /><path d="M20 4v16" /></>
                : <><path d="M4 7h16M4 12h16M4 17h16" /></>}
            </svg>
          </button>
          <Wordmark />
          <span className="season-chip" title={DATA.built ? `Data built ${DATA.built}` : undefined}>
            2026/27 · GW{DATA.gws[0]}–{DATA.gws[DATA.gws.length - 1]}
            {DATA.built && <em className="built-stamp">{DATA.built.slice(0, 10)}</em>}
          </span>
          {ent.user ? (
            <button className="auth-btn" onClick={handleSignOut}
              title={`Signed in as ${ent.user.email}`}>
              <span className="auth-who">{ent.user.email}</span>
              Sign out
            </button>
          ) : (
            <button className="auth-btn cta" onClick={handleSignIn}
              title="Sign in to keep your team saved between visits">
              Sign in to save
            </button>
          )}
        </div>
      </header>


      <main>
        {tab === "squad" && (loaded ? (
          <SquadTab gi={gi} setGi={setGi} squad={squad} capt={capt}
            saveSquad={saveSquad} saveCapt={saveCapt} openSwap={openMarket}
            wide={wide} market={swap} side={side} setSide={setSide}
            setMarketPos={setMarketPos} onSwapIn={swapIn} />
        ) : (
          <div className="page page-blurb">Loading…</div>
        ))}
        {tab === "optimal" && <OptimalTab gi={gi} setGi={setGi} onUseSquad={useSquad} />}
        {tab === "value" && <ValueTab />}
        {tab === "fixtures" && <FixturesTab gi={gi} />}
        {tab === "news" && <TeamNewsTab gi={gi} />}
        {tab === "charts" && <PlayerChartsTab gi={gi} />}
        {tab === "matrix" && <MatrixXITab />}
        {tab === "method" && <MethodTab />}
      </main>

      <nav className={`nav ${railOpen ? "" : "rail-closed"}`} aria-label="Main">
        {TABS.map(([k, l]) => (
          <button key={k} className={`nav-btn ${tab === k ? "on" : ""}`}
            aria-current={tab === k ? "page" : undefined}
            onClick={() => { setTab(k); window.scrollTo({ top: 0 }); }}>
            {ICONS[k]}
            <span className="l">{l}</span>
          </button>
        ))}
      </nav>

      <SwapSheet open={!wide && !!swap} pos={swap?.pos} setPos={setMarketPos}
        current={swap?.out ?? null} squad={squad} gi={gi}
        onPick={swapIn} onClose={() => setSwap(null)} />
    </div>
  );
}
