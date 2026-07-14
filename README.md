# SERUM Project Page

Static GitHub Pages site for the SERUM project.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying to GitHub Pages

1. Push to the default branch of the repo that will host the page.
2. In repo **Settings → Pages**, set **Source** to `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. GitHub serves it at `https://<org>.github.io/<repo>/`.

## Structure

- `index.html` — single-page site (hero, overview, key findings, method, live demo, dashboard, results, BibTeX).
- `assets/figures/` — paper figures exported for web (teaser, pipeline, convergence, user-model graphs).
- `assets/videos/` — dashboard screen recordings (MP4, converted from `assets/gifs/`).
- `assets/authors/` — author photos.
- `assets/serum_colm2026.pdf` — compiled paper.
- `assets/live.js` — frontend for the live inference demo (talks to the SERUM job API over ngrok).

Uses a precompiled Tailwind stylesheet (`assets/tailwind.css`), Font Awesome, and Inter/JetBrains Mono. No build step
needed to deploy; to regenerate the stylesheet after adding new utility classes (in `index.html` or `assets/live.js`):

```bash
npx tailwindcss@3.4.17 -o assets/tailwind.css --minify --content "index.html,assets/live.js"
```
