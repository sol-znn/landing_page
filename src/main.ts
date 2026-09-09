// The whole page: a mark in the middle, a footer, and a canvas behind both.
//
// There is no state to speak of and nothing to fetch -- the only moving parts
// are the motion toggle (which owns the background's lifetime) and the
// footer's proximity highlight.

import './style.css'
import type { Background } from './bg.ts'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

/** Same contract as el(), for the one node addressed by class rather than id.
 *  A `!` here would hand back null and fail later at the first style write. */
function one<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`missing ${selector}`)
  return node
}

const ui = {
  bg: el<HTMLCanvasElement>('bg'),
  mark: one<SVGElement>('.mark'),
  motion: el<HTMLButtonElement>('motion'),
  foot: el<HTMLElement>('foot'),
  netName: el<HTMLElement>('netName'),
  netTag: el<HTMLElement>('netTag'),
}

// ---------------------------------------------------------------------------
// the background
// ---------------------------------------------------------------------------

// three.js is loaded on its own so it lands in a second chunk: the mark is the
// page and it should not wait on a decoration to paint.
//
// Motion defaults on and ignores `prefers-reduced-motion` for that default --
// the toggle button is the actual accessibility affordance. Clicking it stops
// the canvas to a single still frame of the lattice, not a slowed-down loop,
// and the choice persists across visits.
const MOTION_KEY = 'landing:reduced-motion'

function storedReducedMotion(): boolean | null {
  try {
    const v = localStorage.getItem(MOTION_KEY)
    return v === null ? null : v === 'true'
  } catch {
    return null
  }
}

let background: Background | null = null

// Icon-only: a pause glyph while running (click stops it), a play glyph while
// stopped (click resumes it) -- the standard transport-control pairing, so the
// icon alone carries what the click does without a text label.
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>'
const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>'

// The initial call races the dynamic import against a possible early click: if
// someone hits the button before three.js has even loaded, two calls are in
// flight at once. Without a guard, whichever `import()` resolves last wins and
// silently overwrites `background`, leaking the other call's renderer and event
// listeners -- two backgrounds both drawing to the same canvas. A token makes a
// call that's been superseded by a newer one a no-op instead.
let motionToken = 0

async function applyMotion(reduced: boolean): Promise<void> {
  const token = ++motionToken
  ui.motion.setAttribute('aria-pressed', String(reduced))
  const label = reduced ? 'Start motion' : 'Stop motion'
  ui.motion.setAttribute('aria-label', label)
  ui.motion.title = label
  ui.motion.innerHTML = reduced ? PLAY_ICON : PAUSE_ICON
  document.body.classList.toggle('still', reduced)
  try {
    const { startBackground } = await import('./bg.ts')
    if (token !== motionToken) return
    background?.dispose()
    background = startBackground(ui.bg, { reducedMotion: reduced })
  } catch {
    /* no background; the flat one underneath is fine */
  }
}

ui.motion.addEventListener('click', () => {
  const reduced = ui.motion.getAttribute('aria-pressed') !== 'true'
  try {
    localStorage.setItem(MOTION_KEY, String(reduced))
  } catch {
    /* the choice just won't survive a reload */
  }
  applyMotion(reduced)
})

// Motion defaults on, regardless of `prefers-reduced-motion` -- the toggle is
// there for anyone who wants it off, but a first visit doesn't assume it.
applyMotion(storedReducedMotion() ?? false)

// ---------------------------------------------------------------------------
// the footer
// ---------------------------------------------------------------------------

ui.netName.textContent = 'zenoglyphs'
ui.netTag.textContent = 'chmod -w, forever'

// ---------------------------------------------------------------------------
// pointer proximity
// ---------------------------------------------------------------------------

/** Distance from a point to the nearest edge of a rect; 0 anywhere inside it. */
function distanceTo(rect: DOMRect, x: number, y: number): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right)
  const dy = Math.max(rect.top - y, 0, y - rect.bottom)
  return Math.hypot(dx, dy)
}

// The footer lights up green within a small radius -- close enough to forgive
// a pixel or two, not a generous hover zone around it.
const FOOT_RADIUS = 10

// Still wider than the footer's, because the mark is not a hit target: the
// glyph brightens as the pointer crosses the page toward it, so the reach has
// to be enough of the screen for that approach to register at all.
const MARK_RADIUS = 80

/** Eases the linear 0..1 ramp so the glow comes up gently at the far edge of
 *  the radius and firms up near the glyph, rather than climbing flatly. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function setGlow(value: number): void {
  ui.mark.style.setProperty('--glow', value.toFixed(3))
}

// One listener for both, because both need the same event and reading two
// rects per move is cheaper than a second listener's dispatch. Neither element
// moves except on resize, but the rects are read fresh anyway -- caching them
// would need invalidating on resize, font load and the clamp()'s vmin
// recalculation, for a saving nobody can measure.
window.addEventListener('pointermove', (e) => {
  const footRect = ui.foot.getBoundingClientRect()
  ui.foot.classList.toggle('near', distanceTo(footRect, e.clientX, e.clientY) <= FOOT_RADIUS)

  const markRect = ui.mark.getBoundingClientRect()
  const d = distanceTo(markRect, e.clientX, e.clientY)
  setGlow(d >= MARK_RADIUS ? 0 : smoothstep(1 - d / MARK_RADIUS))
})

// A pointer that leaves the window stops sending moves, so without this the
// glyph keeps whatever glow it had at the edge of the screen indefinitely.
// Bound to the root element rather than `document`, which is not reliably a
// pointerleave target across browsers.
document.documentElement.addEventListener('pointerleave', () => {
  setGlow(0)
  ui.foot.classList.remove('near')
})
