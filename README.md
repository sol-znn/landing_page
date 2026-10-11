# landing_page

A one-screen static site: the zenoglyph over an animated network, with the
footer from the faucet. No wallet, no RPC, no server -- it is `index.html`,
one stylesheet, and a WebGL background.

The background (`src/bg.ts`) is a network in depth, flown through slowly:
2,200 nodes in a hollow tunnel around the line of sight, each linked to its
nearest neighbours, with 9,000 specks of dust between them for depth. Light in
the three brand colours travels along the links, a few hundred pulses at a
time. The tunnel's vanishing point is put on the mark, so the field streams out
of it, and the links brighten under the pointer.

How fast a pulse crosses its link is set at the top of `src/bg.ts`:
`PULSE_TRAVEL` holds a `fast` and a `slow` range in seconds, `PULSE_FAST_SHARE`
is the share of links that draw from the fast one, and `PULSE_EVERY` is how
often a link fires, kept separate so a fast link is not also a busy one.

Nine comets in Bitcoin orange run routes through the graph, node to node along
the links, each a bright head with a tail thinning out behind it. They are drawn
as strings of point sprites, not lines: a 1px orange line among a thousand
green ones was not seen. `COMETS`, `COMET_TRAVEL` and `COMET_EVERY` set how
many, how fast and how often.

It replaced a copy of the `zenon-faucet` background, a flat sheet of dots with a
wave in it and eight bars crossing. That was a network in name only, since
nothing connected to anything, and it had no relation to the mark in front of
it. This one is the resting state of the jump below: the same motion, slow.

The wave is still here as the calm alternative (`src/bg-wave.ts`), with a ninth
bar in Bitcoin orange that keeps to the middle of the lattice. The button to
the left of the motion toggle swaps the two; the network is the default and the
choice persists in `localStorage`. Both files export the same
`startBackground`, and each is loaded only when it is the one showing.

The pointer spotlight listens on the window rather than the canvas, so it keeps
tracking while the pointer is over the logo or the footer. The page takes no
notice of the OS reduced-motion setting, which Windows turns on whenever
"Animation effects" is off. It degrades to the flat page colour if WebGL is
unavailable, and the toggle at the bottom right freezes it to a single still
frame -- a choice that persists in `localStorage`.

## The jump

The mark is a link to `https://devnet.zenon.foo` (the `href` on `#jump` in
`index.html`; change it there). A plain click plays a 1.3 s hyperjump into the
mark and then follows the link. Any other click, a new tab, or scripts off,
gets the link as it is.

The jump is done after projection: every node and speck is pushed away from the
middle of the mark by a scale that grows exponentially, which keeps each on a
straight line through that point. Each trails a streak in one of the three
brand colours, and the links fade out as it starts. A halo in the same colours comes up behind the mark at the
click, and a flash opens out of it at the end. The canvas half is `jumpChunk` in
`src/bg.ts`, the rest is under `body.jumping` in `src/style.css`, and
`src/main.ts` runs both off one clock (`JUMP_MS`).

It plays with the motion toggle off as well: the toggle stops the idle loops,
and a click on the mark asks for this one. Coming back with the browser's Back
button resets the page.

`?jump=0.6` holds the animation at that fraction and never navigates, for
looking at one frame of it.

## The projects index

`projects/index.html`, served at `/projects/` and linked from the word above the
GitHub icon. Its rows are generated from `projects/projects.json` by
`scripts/projects.mjs`; the page itself has no script. Each section is a
`<details>`, closed by default, with its row count on the bar. Statuses come from a fixed
set of eight words listed in `src/projects.css`. It is a second entry in
`vite.config.ts`; a page not listed there is left out of `dist/` silently.

Each project names the directories under `C:\dev\zenon` it comes from
(`dirs`), so the tree can be scanned against the page:

```
npm run projects:scan      # what an update would change; writes nothing
npm run projects:deploy    # update, verify, commit, push, wait for Pages, check live
node scripts/projects.mjs verify [--offline]
```

A scan refreshes each project's version from its first directory (newest
`vX.Y.Z` tag, else `package.json`, else `Cargo.toml`), adds a Repo link when
that directory's origin becomes a public `sol-znn` repository, and adds any
directory nobody has claimed as a new project, placed by the `placement`
rules and described from its README's first sentence. A directory is never
proposed if it is in `ignore`, has no `README.md`, or tracks someone else's
repository. Read the scan before deploying: a new project's line and status
are guesses, and are fixed by editing the JSON.

Verify fails on an unknown status, a dash in interface text, an empty
section, a name used twice, HTML out of step with the JSON, a failed build,
a built page missing a row or its stylesheet, or a link that does not
answer. Deploy refuses uncommitted work outside `projects/`, a branch other
than `master`, or one behind `origin`, and ends only when the live page
serves the same rows as the build.

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
