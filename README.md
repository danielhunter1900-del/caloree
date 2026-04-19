# Calorie App

An iOS-style calorie & wellness tracker. Single-file React app (React + Babel via CDN) — no build step.

## Features

- **Today** — animated calorie ring, macro bars, date scrubber, swipe-to-delete meal rows
- **Add Food** — live typeahead search, recent foods, portion slider with quick-multiplier chips
- **Trends** — Week / Month / Year view with chevron navigation through history, plus a stacked "wellness strip chart" correlating Sleep / Coffee / Water / Stress / Calories against Energy
- **AI** — describe a meal in plain English and get structured macros; or paste JSON from an external Claude session
- **Profile** — editable daily goals (kcal/carbs/protein/fat), weight logging with sparkline, theme switcher, settings toggles
- **Wellness** — collapsible card on Today for coffees, water, sleep, stress, energy
- **Three themes** — Clinical, Warm, Editorial (switch from Profile → Appearance)

## Run locally

Any static file server works, e.g.:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo → Settings → Pages → Source: `main` branch, root.
3. App will be served at `https://<username>.github.io/<repo>/`.
