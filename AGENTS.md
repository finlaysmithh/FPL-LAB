# FPL-LAB — Codex Project Instructions

## PROJECT

FPL-LAB is a premium Fantasy Premier League analytics and squad optimisation platform.

The existing FPL prediction engine, calculations, data and UI are valuable and must not be unnecessarily rewritten.

Before making changes:
1. Inspect the existing architecture.
2. Understand how the relevant feature currently works.
3. Reuse existing components, utilities and data structures where appropriate.
4. Do not duplicate functionality.
5. Do not change working FPL calculations unless explicitly requested.

---

# DEVELOPMENT PRINCIPLES

Prioritise:

1. Correctness
2. Security
3. Reliability
4. Maintainability
5. UX
6. Visual polish

Do not make superficial changes that create technical debt.

When making a change, check whether it affects other parts of the application.

After implementing a feature, test the relevant flows and check for regressions.

---

# UI / UX

FPL-LAB should feel like a premium FPL analytics product.

Maintain:
- consistent spacing
- strong visual hierarchy
- responsive layouts
- consistent typography
- logical grouping of controls
- clean cards and panels
- clear primary actions

Do not add unnecessary UI elements.

Do not redesign unrelated parts of the application when implementing a feature.

---

# AUTHENTICATION

The application will support user accounts.

Required authentication capabilities:
- Google sign-in
- secure user sessions
- protected premium routes/features
- persistent user identity

Authentication must be handled securely.

Never trust frontend-only authentication state for security decisions.

The backend/database must determine whether a user is authenticated.

Never expose:
- private API keys
- service-role keys
- OAuth secrets
- Stripe secret keys
- webhook secrets

in frontend code or public repositories.

Use environment variables for secrets.

---

# FREE TIER

Every new user receives one free opportunity to use the core team-rating functionality.

The free allowance must belong to the user's account, NOT the browser.

Example:

free_rating_used = false

After the user performs their free team rating:

free_rating_used = true

The system must prevent users from obtaining another free rating by:
- clearing cookies
- changing browser
- logging out
- using another device
- manipulating frontend state

The server/database must enforce this rule.

Do not rely on localStorage or frontend variables for this restriction.

---

# PREMIUM SUBSCRIPTION

Premium functionality will use Stripe subscriptions.

The application should distinguish between:

FREE
and
PREMIUM

Subscription access must be determined using trusted server-side information.

Do not simply hide premium buttons and assume that prevents access.

Premium API endpoints/data must verify the user's entitlement server-side.

Stripe webhook events must be verified using the Stripe webhook signing secret.

Handle at minimum:
- successful subscription
- subscription renewal
- subscription cancellation
- payment failure
- subscription expiry

The user's premium status should remain synchronised with Stripe.

---

# PAYMENT SECURITY

Never put Stripe secret keys in frontend code.

Never trust:
- price supplied by the browser
- subscription status supplied by the browser
- user IDs supplied without authentication validation
- frontend premium flags

The server should determine:
- authenticated user
- subscription status
- permitted features

Use Stripe Checkout or another Stripe-supported secure payment flow rather than building custom card handling.

---

# PREMIUM FEATURE ACCESS

Structure premium access so that it is easy to extend.

For example:

FREE:
- account creation
- Google login
- one team rating
- basic result

PREMIUM:
- unlimited team analysis
- advanced squad optimisation
- expected points
- transfer planning
- chip planning
- advanced projections
- other premium FPL Matrix features

Do not hard-code premium access throughout dozens of unrelated components.

Use a central entitlement/access system where practical.

---

# DATABASE

User-specific information should be associated with a persistent user ID.

Potential user information includes:
- account
- free-rating usage
- subscription status
- Stripe customer ID
- subscription ID
- timestamps
- relevant user preferences

Do not store sensitive information unnecessarily.

Use appropriate database security policies.

---

# API / BACKEND

Validate all important inputs server-side.

Never assume that because the frontend prevents an action, the user cannot perform it.

Premium data and operations must be protected at the backend/API level.

Errors should fail safely and should not expose secrets or unnecessary internal information.

---

# ENVIRONMENT VARIABLES

Never commit secrets to GitHub.

Use environment variables such as:

DATABASE_URL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

Use the actual environment variable names already established by the project if they differ.

Never invent duplicate configuration systems unnecessarily.

---

# GITHUB

Keep commits focused and descriptive.

Before committing:
- check changed files
- check for accidentally added secrets
- check for generated/build files that should not be committed
- check that the application still builds

Do not commit .env files or secrets.

---

# IMPORTANT CODING RULE

Before implementing a significant architectural change:

Explain briefly:
1. What the existing architecture appears to be.
2. What you intend to change.
3. Why that approach fits the existing project.

Then implement it.

Do not replace the existing architecture simply because another stack is more familiar.

---

# EXISTING FPL ENGINE

The FPL prediction model is core intellectual property of the application.

Do not alter model formulas, constants, projections, scoring logic or data processing unless explicitly instructed.

When changing the UI around the model, preserve the underlying calculations.

If a requested feature requires changing the model, identify the dependency before making the change.

---

# GENERAL RULE

When uncertain:

Inspect first.

Understand the existing implementation.

Make the smallest robust change that solves the problem.

Prefer secure, maintainable architecture over quick hacks.