#!/usr/bin/env bash
# Builds the deployable site/ folder: landing page at the root, the React app
# under /app. Run this after changing either one, then deploy site/ to Vercel
# (or Netlify — both configs ship in the folder).
set -euo pipefail
cd "$(dirname "$0")"

echo "→ checking the methodology page against the live model"
PYTHONPATH=. python3 webapp/check_method.py

echo "→ building the app"
(cd webapp && npm run build)

echo "→ assembling site/"
rm -rf site/app
# Stale hero videos from earlier builds — the landing page now uses
# manager-hero.mp4, and leaving the old ones behind tripled the deploy size.
rm -f site/hero.mp4 site/hero-mobile.mp4 site/hero-poster.jpg
mkdir -p site
cp landing/index.html landing/manager-hero.mp4 landing/manager-poster.jpg site/
cp deploy/netlify.toml deploy/vercel.json site/
cp -R webapp/dist site/app

echo
echo "site/ is ready — $(du -sh site | cut -f1)"
echo "Deploy it with:  npx vercel deploy --prod site"
