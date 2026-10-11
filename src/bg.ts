// The background: a network in depth, flown through slowly, toward the mark.
//
// Zenon calls its chain a Network of Momentum. The first background drew that
// as a flat sheet of dots with a wave in it and a few bars crossing; it was a
// network in name, since nothing connected to anything, and it had nothing to
// do with the mark in front of it. The hyperjump (see jumpChunk) showed what
// the page was missing: a point everything moves in relation to.
//
// So this is the jump's resting state. Nodes fill a tunnel around the line of
// sight and drift toward the viewer, linked to their nearest neighbours, with
// light in the three brand colours passing along the links from node to node.
// The tunnel's vanishing point is put on the mark, so the whole field streams
// out of it, and a click only has to open the throttle.
//
// It is decoration, so it is also disposable: if WebGL is unavailable the page
// keeps its flat background and nothing else changes.

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineSegments,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
} from 'three'

/** Length of the tunnel, in world units. A node that reaches the viewer is
 *  put back at the far end, where the fog has already hidden it. */
const DEPTH = 220
/** The tunnel is hollow: nothing within R_IN of the line of sight, so no
 *  node ever flies through the mark, only past it. R_OUT is wide enough that
 *  near nodes still leave by the corners of a wide window rather than short
 *  of them. */
const R_IN = 8
const R_OUT = 72
/** Linked nodes. More than this and the links stop reading as a graph and
 *  start reading as a mesh. */
const NODES = 2200
/** Unlinked specks between them. At rest they are the depth cue, the thing
 *  that makes the tunnel a volume rather than a ring of dots; in the jump
 *  they are most of the streaks. */
const DUST = 9000
/** A node links to at most this many of its nearest neighbours, and only
 *  within LINK_REACH. Two is a web of chains and small loops; three or more
 *  fills in to a lattice. */
const LINKS_PER_NODE = 2
const LINK_REACH = 17
/** World units per second, at rest. A node takes about 25 s to cross the
 *  tunnel: slow enough to sit behind a logo, fast enough that the near ones
 *  are plainly moving. */
const CRUISE = 9

/** How much slower than the wall clock the shaders' uTime runs. Everything
 *  timed in the shaders is in uTime; the constants below are in seconds and
 *  are converted with this when the links are built. */
const TIME_SCALE = 0.6

/**
 * How long a pulse of light takes to cross its link, in seconds. Each link
 * draws its own time once, from one of two ranges: PULSE_FAST_SHARE of them
 * from `fast`, the rest from `slow`. Two ranges rather than one wide one,
 * because an even spread reads as a single medium speed with noise on it,
 * and the point is to see quick transfers passing slow ones.
 *
 * This is travel time only. How often a link fires is PULSE_EVERY, drawn
 * separately, so a fast link is not also a busy one.
 */
const PULSE_TRAVEL = {
  fast: [0.25, 0.5],
  slow: [1.3, 2.4],
} as const
const PULSE_FAST_SHARE = 0.4
/** Seconds between one pulse and the next on the same link. */
const PULSE_EVERY = [6, 16] as const

const between = ([lo, hi]: readonly [number, number]): number => lo + Math.random() * (hi - lo)

/** The lattice green, read from the Syrius stylesheets like the page's own. */
const GREEN = 0x67e646

/** The brand tri-color, from `zenon-docs/frontend/design-system.md`: Zenon
 *  green, Quasar blue (ZNN's sister token), and the reserved Plasma pink. */
const BRAND = [0x00d557, 0x0061eb, 0xf91690]

/**
 * Perceived-brightness compensation, one multiplier per BRAND entry.
 *
 * Additive blending sums raw RGB, so at equal alpha the three do not read as
 * equally bright: by Rec.709 luma the blue is roughly half as bright as the
 * green, and the pink, red-heavy with a small blue channel, loses that blue
 * first as it dims and reads as plain red. Scaling each colour's RGB up
 * before it reaches the shader raises every channel together, so the hue
 * holds up to the GPU's per-channel clamp.
 */
const BRAND_BRIGHTNESS = [1, 1.75, 1.9]

const brandColor = (i: number): Color => new Color(BRAND[i]).multiplyScalar(BRAND_BRIGHTNESS[i])

/**
 * The flight, shared by every shader.
 *
 * `fly` moves a vertex down the tunnel by uFlight and wraps it. The wrap is
 * taken on `anchor`, not on the vertex's own depth: a link's two ends pass
 * the same anchor, so they wrap on the same frame and the link never
 * stretches the length of the tunnel between a node that has gone round and
 * one that has not. A point passes its own depth and wraps by itself.
 *
 * The slow roll is there because flight alone is not enough to rely on: far
 * nodes barely move on screen, and the roll keeps them turning about the
 * mark. The swell along the tunnel's length is the old background's wave,
 * kept as a breath through the network rather than a surface.
 *
 * `toClip` then moves the vanishing point. A perspective camera puts it in
 * the middle of the canvas; the mark is not quite there (it sits above the
 * footer), so the projection is shifted by uJumpCenter, the mark's position
 * in NDC, and the field converges on the mark wherever layout has put it.
 */
const flightChunk = /* glsl */ `
  uniform float uTime;
  uniform float uFlight;
  uniform float uJump;
  uniform vec2 uJumpCenter;

  const float DEPTH = ${DEPTH.toFixed(1)};

  vec3 fly(vec3 p, float anchor) {
    p.z = mod(anchor + uFlight, DEPTH) - DEPTH + (p.z - anchor);
    float angle = uTime * 0.035;
    float c = cos(angle);
    float s = sin(angle);
    p.xy = mat2(c, -s, s, c) * p.xy;
    p.xy *= 1.0 + 0.06 * sin(p.z * 0.05 + uTime * 0.8);
    return p;
  }

  vec4 toClip(vec3 p) {
    vec4 clip = projectionMatrix * vec4(p, 1.0);
    clip.xy += uJumpCenter * clip.w;
    return clip;
  }

  // Fog at the far end, so nothing is seen arriving, and a fade just short
  // of the viewer, so nothing swells into a disc before it leaves.
  float depthFade(float d) {
    return (1.0 - smoothstep(DEPTH * 0.45, DEPTH, d)) * smoothstep(1.0, 10.0, d);
  }
`

/**
 * The hyperjump.
 *
 * Clicking the mark flies the page into it. Every vertex is pushed away from
 * the mark, after projection, by a scale that grows exponentially with
 * uJump. Scaling about a point keeps each vertex on its own straight line
 * through that point, and since the field already streams out of the mark at
 * rest, the jump is the same motion with the speed taken off its leash.
 *
 * The scale dips just under 1 first: the field draws in toward the mark for
 * a beat before it lets go, which is what makes the launch read as a launch.
 * The per-vertex seed spreads the speeds out so near neighbours separate.
 *
 * At uJump = 0 the scale is exactly 1 and nothing here changes a pixel.
 */
const jumpChunk = /* glsl */ `
  float jumpSeed(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  float jumpScale(float t, float seed) {
    float charge = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.2, 0.32, t));
    float launch = max(t - 0.2, 0.0) / 0.8;
    return 1.0 - 0.07 * charge + (exp(launch * 4.6) - 1.0) * 0.16 * (0.55 + seed * 0.9);
  }

  vec4 jumpWarp(vec4 clip, float t, float seed) {
    vec2 ndc = clip.xy / clip.w;
    vec2 warped = uJumpCenter + (ndc - uJumpCenter) * jumpScale(t, seed);
    return vec4(warped * clip.w, clip.zw);
  }
`

// ---------------------------------------------------------------------------
// points: the nodes and the dust, in one draw
// ---------------------------------------------------------------------------

const pointVertexShader = /* glsl */ `
  ${flightChunk}
  ${jumpChunk}
  uniform float uSize;
  uniform float uCenterGlow;
  uniform vec2 uMouse;
  attribute vec3 aColor;
  // x: size, y: brightness. A node is (about 1, 1); dust is small and dim.
  attribute vec2 aLook;
  varying vec3 vColor;
  varying float vGlow;

  void main() {
    vColor = aColor;
    float seed = jumpSeed(position);
    vec3 p = fly(position, position.z);
    float d = -p.z;
    vec4 clip = toClip(p);
    vec2 ndc = clip.xy / clip.w;

    // uCenterGlow pulls extra brightness toward the mark. Used for the still
    // image, which has no flight to carry the eye there.
    float centerBoost = uCenterGlow * (1.0 - smoothstep(0.0, 1.1, length(ndc - uJumpCenter))) * 1.2;

    // A soft spotlight that follows the pointer. uMouse sits far off-screen
    // until the first move, so this is 0 everywhere before that.
    float mouseBoost = (1.0 - smoothstep(0.0, 0.45, length(ndc - uMouse))) * 1.5;

    // The jump lights the field around the mark as it charges, then all of
    // it as it goes, and fattens the points into the heads of their streaks.
    float launch = smoothstep(0.2, 1.0, uJump);
    float jumpFalloff = 1.0 - smoothstep(0.0, 0.9, length(ndc - uJumpCenter));
    float jumpBoost = smoothstep(0.0, 0.2, uJump) * (jumpFalloff * 1.3 + launch * 0.8);

    // Each point on its own slow beat, so the field is never evenly lit.
    float twinkle = 0.72 + 0.28 * sin(uTime * 1.7 + seed * 6.2832);

    float boost = 1.0 + centerBoost + mouseBoost + jumpBoost;
    vGlow = min(depthFade(d) * aLook.y * twinkle * boost, 1.4 + launch);

    gl_PointSize = min(uSize * aLook.x * (70.0 / d) * (1.0 + mouseBoost * 0.35) * (1.0 + launch * 1.2), 48.0);
    gl_Position = jumpWarp(clip, uJump, seed);
  }
`

const pointFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vGlow;

  void main() {
    // Round the square point sprite off, and fade it at the rim.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float falloff = 1.0 - smoothstep(0.04, 0.25, r);

    float alpha = falloff * vGlow * 0.85;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`

// ---------------------------------------------------------------------------
// links: the graph, and the light moving through it
// ---------------------------------------------------------------------------

/**
 * A link is one line between two nodes. At rest it is a hairline in the
 * lattice green, just visible, and brighter under the pointer, so moving the
 * pointer across the page shows the network that is there.
 *
 * The light is drawn in the fragment shader: aT runs 0 to 1 along the link,
 * and a pulse is a short bright band whose position depends on the link's own
 * clock. Each link fires, goes dark for most of its cycle, and fires again,
 * in one of the three brand colours. Hundreds are in flight at once, most of
 * them small and far, which is the difference between this and the three or
 * four bars the old background had: those read as comets crossing a picture,
 * these read as traffic.
 */
const linkVertexShader = /* glsl */ `
  ${flightChunk}
  ${jumpChunk}
  uniform vec2 uMouse;
  attribute float aAnchor;
  attribute float aT;
  attribute float aSeed;
  // x: uTime between pulses, y: uTime a pulse takes to cross.
  attribute vec2 aPulse;
  attribute vec3 aColor;
  varying float vT;
  varying float vSeed;
  varying vec2 vPulse;
  varying float vFade;
  varying float vMouse;
  varying vec3 vColor;

  void main() {
    vT = aT;
    vSeed = aSeed;
    vPulse = aPulse;
    vColor = aColor;

    vec3 p = fly(position, aAnchor);
    vec4 clip = toClip(p);
    vec2 ndc = clip.xy / clip.w;
    vMouse = 1.0 - smoothstep(0.0, 0.45, length(ndc - uMouse));

    // A link cannot follow two nodes that are flying apart at different
    // speeds, so it is gone before they start to.
    vFade = depthFade(-p.z) * (1.0 - smoothstep(0.1, 0.3, uJump));

    // Each end takes its own node's seed, so through the charge, while it is
    // still drawn, it stays on the node.
    gl_Position = jumpWarp(clip, uJump, jumpSeed(position));
  }
`

const linkFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying float vT;
  varying float vSeed;
  varying vec2 vPulse;
  varying float vFade;
  varying float vMouse;
  varying vec3 vColor;

  void main() {
    // Lit for the first part of each cycle. The head starts a little before
    // one end and finishes a little past the other, so the band enters and
    // leaves rather than appearing whole.
    //
    // Time since this link last fired, and how far across that puts the
    // head. The two are separate numbers per link (see PULSE_TRAVEL), so how
    // fast the light moves says nothing about how often it comes.
    float since = mod(uTime + vSeed * vPulse.x, vPulse.x);
    float head = since / vPulse.y * 1.3 - 0.15;
    // A quick pulse is drawn longer, as anything quick is seen: the same
    // short band at four times the speed reads as a flicker, not a transfer.
    float width = mix(0.2, 0.1, smoothstep(0.2, 0.9, vPulse.y));
    float pulse = since < vPulse.y ? exp(-pow((vT - head) / width, 2.0)) : 0.0;

    vec3 color = uColor * (0.3 + vMouse * 0.5) + vColor * pulse * 1.4;
    if (vFade * max(color.r, max(color.g, color.b)) < 0.004) discard;
    gl_FragColor = vec4(color, vFade);
  }
`

// ---------------------------------------------------------------------------
// streaks: the jump's trails
// ---------------------------------------------------------------------------

/**
 * One line per point, from where the point was a moment ago to where it is
 * now. Both ends sit on the point's own position and run the same flight and
 * the same jumpWarp, the tail a fixed step of uJump behind the head, so a
 * streak has no length until the field accelerates and gets longer the
 * faster its point is going, without any length being set here.
 *
 * Each takes one of the three brand colours, in even thirds. Not drawn at
 * all outside a jump.
 */
const streakVertexShader = /* glsl */ `
  ${flightChunk}
  ${jumpChunk}
  attribute vec3 aColor;
  attribute float aEnd;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec3 p = fly(position, position.z);
    float t = aEnd > 0.5 ? uJump : max(uJump - 0.11, 0.0);
    gl_Position = jumpWarp(toClip(p), t, jumpSeed(position));

    // Bright at the head, nothing at the tail, and not drawn at all until the
    // charge is over: during it the two ends are a pixel apart.
    vAlpha = aEnd * smoothstep(0.22, 0.4, uJump) * (0.25 + 0.75 * depthFade(-p.z)) * 0.85;
  }
`

const streakFragmentShader = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    if (vAlpha < 0.004) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`

// ---------------------------------------------------------------------------
// comets: Bitcoin's orange, running the graph
// ---------------------------------------------------------------------------

/** Bitcoin's orange. Lifted a little for the same additive-blending reason
 *  as BRAND_BRIGHTNESS. */
const BITCOIN_ORANGE = new Color(0xf7931a).multiplyScalar(1.25)

/** How many comets, each on its own route. Enough that one is nearly always
 *  somewhere on screen: a route is in the fog or behind the viewer for much
 *  of the tunnel's turn, and a single comet was simply never seen. */
const COMETS = 9
/** A route is a walk along links, this many hops at most and at least
 *  COMET_MIN_HOPS, or it is over before it reads as a journey. */
const COMET_HOPS = 14
const COMET_MIN_HOPS = 5
/** Routes start within this radius of the line of sight, so a comet crosses
 *  the picture rather than its edge. */
const COMET_START_R = 34
/** Seconds to run a route, and seconds between runs. */
const COMET_TRAVEL = [2.6, 4.2] as const
const COMET_EVERY = [5.5, 9] as const
/** World units between the sprites a comet is drawn with. Close enough that
 *  they fuse into a line at any distance it is visible from. */
const COMET_STEP = 0.3

/**
 * A comet is the one thing here that is not a 1px line, because a 1px line
 * in orange among a thousand in green is not seen. It is a string of point
 * sprites laid along a route through the graph, every COMET_STEP units, each
 * knowing how far along the route it is (aS). The shader lights the ones
 * just behind the head and sizes them by how close behind, so the head is a
 * fat bright bead and the tail thins out along the links it has just used.
 *
 * The whole route wraps on one anchor, like a link, so it goes round the
 * tunnel in one piece.
 */
const cometVertexShader = /* glsl */ `
  ${flightChunk}
  ${jumpChunk}
  uniform float uSize;
  attribute float aAnchor;
  attribute float aS;
  attribute float aSeed;
  // x: uTime between runs, y: uTime a run takes.
  attribute vec2 aPulse;
  varying float vGlow;
  varying float vHead;

  void main() {
    vec3 p = fly(position, aAnchor);
    float d = -p.z;
    vec4 clip = toClip(p);

    // The head runs past the end of the route (to 1.35) so the tail has
    // cleared it before the run is over, rather than being cut off.
    float since = mod(uTime + aSeed * aPulse.x, aPulse.x);
    float head = since / aPulse.y * 1.4 - 0.05;
    float behind = head - aS;
    float glow = behind >= 0.0 ? exp(-behind * 13.0) : exp(behind * 140.0);
    glow *= step(since, aPulse.y);

    vGlow = glow * depthFade(d) * (1.0 - smoothstep(0.1, 0.3, uJump));
    vHead = 1.0 - smoothstep(0.0, 0.05, abs(behind));

    gl_PointSize = min(uSize * (70.0 / d) * (0.45 + 2.4 * glow), 48.0);
    gl_Position = jumpWarp(clip, uJump, 0.5);
  }
`

const cometFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vGlow;
  varying float vHead;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float falloff = 1.0 - smoothstep(0.02, 0.25, r);

    float alpha = falloff * vGlow * 0.6;
    if (alpha < 0.004) discard;
    // Hotter at the head: toward a pale amber, not white, so it is still
    // orange where it is brightest.
    gl_FragColor = vec4(mix(uColor, vec3(1.0, 0.82, 0.5), vHead * 0.55), alpha);
  }
`

/** Walks the graph from a node near the middle of the tunnel, never back
 *  onto a node it has used. Returns null when the walk dead-ends early; the
 *  caller tries again from somewhere else. */
function cometRoute(nodes: [number, number, number][], adjacency: number[][]): number[] | null {
  const start = Math.floor(Math.random() * nodes.length)
  if (Math.hypot(nodes[start][0], nodes[start][1]) > COMET_START_R) return null
  const route = [start]
  const used = new Set(route)
  while (route.length <= COMET_HOPS) {
    const options = adjacency[route[route.length - 1]].filter((n) => !used.has(n))
    if (options.length === 0) break
    const next = options[Math.floor(Math.random() * options.length)]
    route.push(next)
    used.add(next)
  }
  return route.length > COMET_MIN_HOPS ? route : null
}

function buildComets(nodes: [number, number, number][], adjacency: number[][]): BufferGeometry {
  const pos: number[] = []
  const anchor: number[] = []
  const along: number[] = []
  const seeds: number[] = []
  const pulse: number[] = []

  let built = 0
  // Bounded: a graph this size has thousands of long-enough walks, but a
  // loop that depends on random luck gets a ceiling regardless.
  for (let attempt = 0; attempt < 4000 && built < COMETS; attempt++) {
    const route = cometRoute(nodes, adjacency)
    if (!route) continue
    built++

    let total = 0
    for (let i = 1; i < route.length; i++) {
      const a = nodes[route[i - 1]]
      const b = nodes[route[i]]
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    }

    const seed = Math.random()
    const travel = between(COMET_TRAVEL) * TIME_SCALE
    const every = between(COMET_EVERY) * TIME_SCALE
    const anchorZ = nodes[route[0]][2]
    let done = 0
    for (let i = 1; i < route.length; i++) {
      const a = nodes[route[i - 1]]
      const b = nodes[route[i]]
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      for (let s = 0; s < length; s += COMET_STEP) {
        const f = s / length
        pos.push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)
        anchor.push(anchorZ)
        along.push((done + s) / total)
        seeds.push(seed)
        pulse.push(every, travel)
      }
      done += length
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.setAttribute('aAnchor', new Float32BufferAttribute(anchor, 1))
  geometry.setAttribute('aS', new Float32BufferAttribute(along, 1))
  geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1))
  geometry.setAttribute('aPulse', new Float32BufferAttribute(pulse, 2))
  return geometry
}

// ---------------------------------------------------------------------------
// building it
// ---------------------------------------------------------------------------

/** A point in the tunnel: uniform over its cross-section between R_IN and
 *  R_OUT (hence the square root), uniform along its length. z is stored as a
 *  distance down the tunnel, 0..DEPTH, and `fly` turns it into a position. */
function tunnelPoint(): [number, number, number] {
  const r = Math.sqrt(R_IN * R_IN + Math.random() * (R_OUT * R_OUT - R_IN * R_IN))
  const a = Math.random() * Math.PI * 2
  return [Math.cos(a) * r, Math.sin(a) * r, Math.random() * DEPTH]
}

interface Field {
  points: Points
  links: LineSegments
  streaks: LineSegments
  comets: Points
  materials: ShaderMaterial[]
}

function buildField(): Field {
  const green = new Color(GREEN)
  const nodes: [number, number, number][] = []
  for (let i = 0; i < NODES; i++) nodes.push(tunnelPoint())

  // --- points ---
  const pointPos: number[] = []
  const pointColor: number[] = []
  const pointLook: number[] = []
  for (const [x, y, z] of nodes) {
    pointPos.push(x, y, z)
    // Mostly the lattice green; about one node in four wears blue or pink,
    // so the three colours are in the picture before any light moves.
    const pick = Math.random()
    const color = pick < 0.76 ? green : brandColor(pick < 0.88 ? 1 : 2)
    pointColor.push(color.r, color.g, color.b)
    pointLook.push(0.8 + Math.random() * 1.0, 1)
  }
  for (let i = 0; i < DUST; i++) {
    pointPos.push(...tunnelPoint())
    pointColor.push(green.r, green.g, green.b)
    pointLook.push(0.26 + Math.random() * 0.16, 0.5)
  }

  const pointGeometry = new BufferGeometry()
  pointGeometry.setAttribute('position', new Float32BufferAttribute(pointPos, 3))
  pointGeometry.setAttribute('aColor', new Float32BufferAttribute(pointColor, 3))
  pointGeometry.setAttribute('aLook', new Float32BufferAttribute(pointLook, 2))

  // --- links ---
  // Nearest neighbours by brute force: 2200 nodes is five million distance
  // checks, once, which costs less than the import of a spatial index would.
  // Distance ignores the tunnel's seam, so no link crosses it.
  const linkPos: number[] = []
  const linkAnchor: number[] = []
  const linkT: number[] = []
  const linkSeed: number[] = []
  const linkPulse: number[] = []
  const linkColor: number[] = []
  const seen = new Set<number>()
  // Who each node is linked to, in either direction: the comets' map.
  const adjacency: number[][] = nodes.map(() => [])
  const reach2 = LINK_REACH * LINK_REACH
  for (let i = 0; i < NODES; i++) {
    const near: { j: number; d2: number }[] = []
    for (let j = 0; j < NODES; j++) {
      if (j === i) continue
      const dx = nodes[i][0] - nodes[j][0]
      const dy = nodes[i][1] - nodes[j][1]
      const dz = nodes[i][2] - nodes[j][2]
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < reach2) near.push({ j, d2 })
    }
    near.sort((a, b) => a.d2 - b.d2)
    for (const { j } of near.slice(0, LINKS_PER_NODE)) {
      const key = Math.min(i, j) * NODES + Math.max(i, j)
      if (seen.has(key)) continue
      seen.add(key)
      adjacency[i].push(j)
      adjacency[j].push(i)
      const a = nodes[i]
      const b = nodes[j]
      const seed = Math.random()
      const every = between(PULSE_EVERY) * TIME_SCALE
      const travel = between(Math.random() < PULSE_FAST_SHARE ? PULSE_TRAVEL.fast : PULSE_TRAVEL.slow) * TIME_SCALE
      const color = brandColor(Math.floor(Math.random() * BRAND.length))
      linkPos.push(a[0], a[1], a[2], b[0], b[1], b[2])
      linkAnchor.push(a[2], a[2])
      linkT.push(0, 1)
      linkSeed.push(seed, seed)
      linkPulse.push(every, travel, every, travel)
      linkColor.push(color.r, color.g, color.b, color.r, color.g, color.b)
    }
  }

  const linkGeometry = new BufferGeometry()
  linkGeometry.setAttribute('position', new Float32BufferAttribute(linkPos, 3))
  linkGeometry.setAttribute('aAnchor', new Float32BufferAttribute(linkAnchor, 1))
  linkGeometry.setAttribute('aT', new Float32BufferAttribute(linkT, 1))
  linkGeometry.setAttribute('aSeed', new Float32BufferAttribute(linkSeed, 1))
  linkGeometry.setAttribute('aPulse', new Float32BufferAttribute(linkPulse, 2))
  linkGeometry.setAttribute('aColor', new Float32BufferAttribute(linkColor, 3))

  // --- streaks ---
  const streakPos: number[] = []
  const streakColor: number[] = []
  const streakEnd: number[] = []
  for (let i = 0; i < pointPos.length; i += 3) {
    const color = brandColor(Math.floor(Math.random() * BRAND.length))
    streakPos.push(pointPos[i], pointPos[i + 1], pointPos[i + 2], pointPos[i], pointPos[i + 1], pointPos[i + 2])
    streakColor.push(color.r, color.g, color.b, color.r, color.g, color.b)
    streakEnd.push(0, 1)
  }

  const streakGeometry = new BufferGeometry()
  streakGeometry.setAttribute('position', new Float32BufferAttribute(streakPos, 3))
  streakGeometry.setAttribute('aColor', new Float32BufferAttribute(streakColor, 3))
  streakGeometry.setAttribute('aEnd', new Float32BufferAttribute(streakEnd, 1))

  // One set of flight uniforms, shared by reference: a value written to one
  // material is the value all three draw with, so they cannot drift apart.
  const shared = {
    uTime: { value: 0 },
    uFlight: { value: 0 },
    uJump: { value: 0 },
    uJumpCenter: { value: new Vector2(0, 0) },
    // Off-screen sentinel: further than the spotlight's radius from any
    // point on screen, so it is invisible until the first move.
    uMouse: { value: new Vector2(10, 10) },
    // Shared so the one write on resize reaches the nodes and the comets.
    uSize: { value: 3.4 },
  }
  const base = { transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending }

  const pointMaterial = new ShaderMaterial({
    ...base,
    uniforms: { ...shared, uCenterGlow: { value: 0 } },
    vertexShader: pointVertexShader,
    fragmentShader: pointFragmentShader,
  })
  const linkMaterial = new ShaderMaterial({
    ...base,
    uniforms: { ...shared, uColor: { value: green } },
    vertexShader: linkVertexShader,
    fragmentShader: linkFragmentShader,
  })
  const streakMaterial = new ShaderMaterial({
    ...base,
    uniforms: { ...shared },
    vertexShader: streakVertexShader,
    fragmentShader: streakFragmentShader,
  })

  const cometMaterial = new ShaderMaterial({
    ...base,
    uniforms: { ...shared, uColor: { value: BITCOIN_ORANGE } },
    vertexShader: cometVertexShader,
    fragmentShader: cometFragmentShader,
  })

  const points = new Points(pointGeometry, pointMaterial)
  const links = new LineSegments(linkGeometry, linkMaterial)
  const streaks = new LineSegments(streakGeometry, streakMaterial)
  const comets = new Points(buildComets(nodes, adjacency), cometMaterial)
  // The shaders move every vertex, down the tunnel and then again after
  // projection, so three's bounding-sphere test would cull against where
  // they are not.
  for (const object of [points, links, streaks, comets]) object.frustumCulled = false
  streaks.visible = false

  return { points, links, streaks, comets, materials: [pointMaterial, linkMaterial, streakMaterial, cometMaterial] }
}

export interface Background {
  dispose(): void
  /** Puts the vanishing point at (x, y) in NDC: the middle of the mark. */
  aim(x: number, y: number): void
  /** Sets the hyperjump: `progress` 0..1, toward (x, y) in NDC. 0 is the
   *  ordinary background. The caller owns the clock, so the page's own
   *  animation and this one run off a single timeline. */
  setJump(progress: number, x: number, y: number): void
}

export interface BackgroundOptions {
  /** `true` freezes the background to a single still frame; `false`, the
   *  default, runs the full animation. Set by the page's own toggle. */
  reducedMotion?: boolean
}

export function startBackground(canvas: HTMLCanvasElement, opts: BackgroundOptions = {}): Background | null {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
  } catch {
    return null
  }

  renderer.setClearColor(0x000000, 0)

  // At the origin, looking down the tunnel. Everything else is in `fly`.
  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 1, 0.5, DEPTH + 10)

  const field = buildField()
  scene.add(field.links, field.points, field.comets, field.streaks)
  const [pointMaterial] = field.materials
  // Shared by reference across all three materials; see buildField.
  const u = pointMaterial.uniforms

  // The OS reduced-motion setting is not read here, on purpose. Windows
  // reports it whenever "Animation effects" is off, which nobody chose on the
  // machines this is seen on, and it left the page still. The toggle on the
  // page is the only thing that stops the motion.
  const still = opts.reducedMotion ?? false

  const draw = (): void => renderer.render(scene, camera)

  const resize = (redraw: boolean): void => {
    const width = canvas.clientWidth || window.innerWidth
    const height = canvas.clientHeight || window.innerHeight
    const ratio = Math.min(window.devicePixelRatio, 2)
    renderer.setPixelRatio(ratio)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    // gl_PointSize is in device pixels, so the same node would be half the
    // size on a 2x screen without this.
    u.uSize.value = 3.4 * ratio
    if (redraw) draw()
  }

  // The pointer spotlight, in NDC (-1..1). Bound to the window rather than
  // the canvas: the canvas is the bottom layer, so anything stacked over it
  // takes the pointer events for itself and the spotlight would freeze
  // wherever it was when the pointer crossed onto the mark or the footer.
  // The canvas is fixed at inset:0, so its rect is the viewport.
  const onPointerMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect()
    u.uMouse.value.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1))
    if (still) draw()
  }
  const onPointerLeave = (): void => {
    u.uMouse.value.set(10, 10)
    if (still) draw()
  }
  const onResize = (): void => resize(still)

  window.addEventListener('resize', onResize)
  window.addEventListener('pointermove', onPointerMove)
  document.documentElement.addEventListener('pointerleave', onPointerLeave)

  const aim = (x: number, y: number): void => {
    u.uJumpCenter.value.set(x, y)
    if (still) draw()
  }

  // Each call draws the frame it asks for when nothing else will. The jump
  // plays on a stopped page too: stopping the background stops the idle
  // loop, and a click on the mark is a request for this one animation.
  const setJump = (progress: number, x: number, y: number): void => {
    u.uJump.value = progress
    u.uJumpCenter.value.set(x, y)
    field.streaks.visible = progress > 0
    if (still) draw()
  }

  const disposeField = (): void => {
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pointermove', onPointerMove)
    document.documentElement.removeEventListener('pointerleave', onPointerLeave)
    for (const object of [field.points, field.links, field.streaks, field.comets]) object.geometry.dispose()
    for (const material of field.materials) material.dispose()
    renderer.dispose()
  }

  // "Stop motion" means stop: one frame of the network, lit toward the mark,
  // with no flight, no light on the links and no requestAnimationFrame loop
  // underneath. The pointer still lights what it passes over, one redraw per
  // move, and a resize redraws so the frame never stretches.
  if (still) {
    u.uCenterGlow.value = 1
    resize(true)
    return { aim, setJump, dispose: disposeField }
  }

  resize(false)

  let frame = 0
  let running = true
  const start = performance.now()

  const tick = (): void => {
    if (!running) return
    frame = requestAnimationFrame(tick)
    const seconds = (performance.now() - start) / 1000
    u.uTime.value = seconds * TIME_SCALE
    // Kept inside one tunnel length: `fly` wraps on it anyway, and a float
    // that only ever grows loses the precision the wrap depends on.
    u.uFlight.value = (seconds * CRUISE) % DEPTH
    draw()
  }

  tick()

  // A background nobody is looking at should not cost a phone its battery.
  const onVisibility = (): void => {
    if (document.hidden) {
      running = false
      cancelAnimationFrame(frame)
    } else if (!running) {
      running = true
      tick()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    aim,
    setJump,
    dispose(): void {
      running = false
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
      disposeField()
    },
  }
}
