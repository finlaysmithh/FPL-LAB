// Central entitlement state — the one place the app asks "what is this user
// allowed to do?".
//
// The free tier's shape (see AGENTS.md): every user gets ONE free team rating.
// Everything up to that rating is free — building the fifteen, browsing the
// market, making transfers, changing their mind as often as they like. The
// rating is the product, so THAT is the thing that is metered: the moment they
// spend it, the squad it was spent on is frozen, and changing it (or rating a
// different one) is a premium action.
//
// The order matters and got built backwards once already: transfers were
// locked BEFORE the first rating, which meters the wrong thing — it charges
// for assembling the question instead of for the answer. A user who cannot
// touch their squad has nothing worth rating.
//
// TRUST BOUNDARY — read before extending this file. This is display-level
// state in localStorage, which means it is a UX courtesy, not enforcement:
// anyone can clear it. That is acceptable today because the whole app is
// static and every "premium" computation already ships to the client, so
// there is nothing server-side to protect yet. The moment accounts and paid
// tiers exist, `free_rating_used` and `tier` move behind the API and this
// module becomes a cache of the server's answer — the shape of the functions
// below is chosen so only this file changes when that happens. Never branch
// on localStorage for anything that costs money.

import { useSyncExternalStore } from "react";
import { storage } from "./logic.js";

const KEY = "entitlement";

const DEFAULT = {
  tier: "free",
  freeRatingUsed: false,
  ratedAt: null,       // ISO date the free rating was spent
  ratedSquad: null,    // the fifteen it was spent on, for the lock banner
  // The signed-in account, or null. PLACEHOLDER identity: an email the user
  // types, kept on this device — it exists so the app can already behave
  // differently for signed-in users (a saved team survives a visit; an
  // anonymous team does not). When Google sign-in lands (see AGENTS.md) this
  // becomes the server's session and only this module changes.
  user: null,          // { email, since } | null
};

let state = { ...DEFAULT };
const listeners = new Set();

// Synchronous read at module load, so the first render does not flash the
// unlocked UI at a user whose rating is already spent. `storage` is async by
// interface but localStorage-backed, so this stays best-effort and the async
// load below confirms it.
try {
  const raw = localStorage.getItem("fpllab:" + KEY);
  if (raw) state = { ...DEFAULT, ...JSON.parse(raw) };
} catch (e) { /* first visit */ }

const emit = () => listeners.forEach((fn) => fn());

async function persist() {
  try { await storage.set(KEY, JSON.stringify(state)); } catch (e) {}
}

export function getEntitlement() {
  return state;
}

export function isPremium() {
  return state.tier === "premium";
}

// The rating allowance belongs to the ACCOUNT (AGENTS.md is explicit about
// this), so an anonymous visitor cannot spend it and, symmetrically, cannot be
// locked by it: their team is ephemeral — blank on every visit — which is its
// own tier. Sign in to rate; rate and the saved squad freezes.

/** May the user change their squad right now? Anonymous teams are ephemeral
 *  and always editable; a signed-in free account edits until the free rating
 *  is spent; premium always can. */
export function canEditSquad() {
  return isPremium() || !isSignedIn() || !state.freeRatingUsed;
}

/** Has this account rated its squad (so the rating panels should show)? */
export function hasRated() {
  return isPremium() || (isSignedIn() && state.freeRatingUsed);
}

/** Spend the account's one free rating on this squad. Requires sign-in;
 *  idempotent — rating the same squad twice is one rating, not two. */
export function consumeFreeRating(squadIds) {
  if (!isSignedIn() || isPremium() || state.freeRatingUsed) return;
  state = {
    ...state,
    freeRatingUsed: true,
    ratedAt: new Date().toISOString(),
    ratedSquad: [...squadIds],
  };
  persist();
  emit();
}

export function isSignedIn() {
  return state.user != null;
}

/** Sign in with an email. Placeholder auth (see `user` above): it grants no
 *  access to anything server-side because nothing server-side exists yet —
 *  it is an identity to hang persistence on, nothing more. */
export function signIn(email) {
  state = { ...state, user: { email: String(email), since: new Date().toISOString() } };
  persist();
  emit();
}

export function signOut() {
  state = { ...state, user: null };
  persist();
  emit();
}

/** React hook: re-renders on entitlement changes. */
export function useEntitlement() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getEntitlement,
  );
}
