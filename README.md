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

- `index.html` — single-page site (hero, abstract, method, highlights, demo, BibTeX).
- `assets/` — images, videos, PDFs (currently empty).

Uses Tailwind (CDN), Font Awesome, and Academicons. No build step.
