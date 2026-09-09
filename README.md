# landing_page

A one-screen static site: the zenoglyph over an animated lattice, with the
footer from the faucet. No wallet, no RPC, no server -- it is `index.html`,
one stylesheet, and a WebGL background.

The background (`src/bg.ts`) comes from `zenon-faucet`: a flat grid of points
lit by crossing sine waves, with coloured bars firing along rows and columns.
The one change from that copy is that its pointer spotlight listens on the
window instead of the canvas, so it keeps tracking while the pointer is over
the logo or the footer -- on this page the canvas is covered by them, where in
the faucet it was mostly bare. It degrades to the flat page colour if WebGL is unavailable,
and the toggle at the bottom right freezes it to a single still frame -- a
choice that persists in `localStorage`.

## Running it

```
npm install
npm run dev      # http://localhost:5181
npm run build    # type-check, then bundle to dist/
npm run preview
```

## Deploying

`.github/workflows/deploy.yml` builds and publishes `dist/` to GitHub Pages on
every push to `master` (or manually via workflow_dispatch). One-time setup:
Settings -> Pages -> Source: GitHub Actions, and Settings -> Pages -> Custom
domain: `zenon.foo`. Nothing in this bundle is secret, so no repository secrets
are needed.

`vite.config.ts` reads `LANDING_BASE_PATH` for the asset path prefix and
defaults to `/`, which is what the custom domain needs -- it serves from the
root. Set the `LANDING_BASE_PATH` repository variable to `/<repo>/` only if the
custom domain is dropped and the site goes back to the plain
`https://<owner>.github.io/<repo>/` URL, which serves from a subdirectory.

Getting that prefix wrong fails quietly and looks like a styling bug rather
than a deploy one: every `assets/...` URL 404s, no stylesheet loads, and the
page renders as a white background with a black logo.
