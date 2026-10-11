#!/usr/bin/env node
// The projects index, kept from projects/projects.json.
//
//   node scripts/projects.mjs scan      what update would change; writes nothing
//   node scripts/projects.mjs update    apply it to projects.json, then render
//   node scripts/projects.mjs render    projects.json -> projects/index.html
//   node scripts/projects.mjs verify    data, render, build, dist and link checks
//   node scripts/projects.mjs deploy    update, verify, commit, push, wait for
//                                       the Pages run, check the live page
//
// Flags: --offline skips the network (repo visibility and link checks);
// --dry-run makes deploy stop before it commits.
//
// The same tree gives the same output: directories are read in sorted order,
// the JSON is written by one serializer, and the HTML is a pure function of
// the JSON. The only inputs from outside the tree are whether a GitHub repo is
// public (decides a Repo link) and, in verify, whether each link answers.
//
// What a scan does with each directory under the root (`root` in the JSON,
// the parent of this repo by default):
//   - listed in some project's `dirs`: its version is refreshed from the
//     first dir of that project (latest vX.Y.Z tag, else package.json, else
//     Cargo.toml), and a Repo link is added if its origin is a public GitHub
//     repo of one of `owners` and the project does not link it yet;
//   - in `ignore`, without a README.md, with an origin owned by someone not
//     in `owners`, or with a name that is not a plain identifier: skipped;
//   - anything else is a new project, placed by the first `placement` rule
//     whose regex matches its name, described from package.json, Cargo.toml
//     or the README's first sentence, and given status prototype if it has a
//     build manifest, research if not. Edit the row afterwards if the guess
//     is poor; the scan never touches a field it did not derive.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_PATH = join(REPO, 'projects', 'projects.json')
const HTML_PATH = join(REPO, 'projects', 'index.html')
const DIST_HTML = join(REPO, 'dist', 'projects', 'index.html')
const BEGIN = '<!-- projects:begin -->'
const END = '<!-- projects:end -->'
const LABELS = {
  live: 'Live', devnet: 'Devnet', review: 'In review', active: 'Active',
  prototype: 'Prototype', research: 'Research', stable: 'Stable', deprecated: 'Deprecated',
}
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pubspec.yaml', 'pyproject.toml', 'Makefile']

const args = process.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('--')) ?? 'scan'
const OFFLINE = args.includes('--offline')
const DRY = args.includes('--dry-run')

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg) }
const log = (...a) => console.log(...a)

// --- data ------------------------------------------------------------------

const load = () => JSON.parse(readFileSync(JSON_PATH, 'utf8'))

// One layout for the JSON whoever wrote it last: objects one key per line,
// short arrays on one line, so a diff of the file reads as a diff of rows.
function serialize(v, ind = '') {
  const next = ind + '  '
  const flat = (x) => x === null || typeof x !== 'object' || (Array.isArray(x) && x.every(flat))
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const inline = '[' + v.map((x) => serialize(x, next)).join(', ') + ']'
    if (v.every(flat) && ind.length + inline.length <= 100) return inline
    return '[\n' + v.map((x) => next + serialize(x, next)).join(',\n') + '\n' + ind + ']'
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    return '{\n' + keys.map((k) => next + JSON.stringify(k) + ': ' + serialize(v[k], next)).join(',\n') + '\n' + ind + '}'
  }
  return JSON.stringify(v)
}
const save = (data) => writeFileSync(JSON_PATH, serialize(data) + '\n')

const allProjects = (data) => data.sections.flatMap((s) => s.projects.map((p) => ({ section: s, p })))

// --- reading the tree ------------------------------------------------------

const rootDir = (data) => resolve(REPO, data.root ?? '..')

function git(dir, ...a) {
  try {
    return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function originOf(dir) {
  if (!existsSync(join(dir, '.git'))) return null
  const url = git(dir, 'remote', 'get-url', 'origin')
  if (!url) return null
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { url, owner: m[1], name: m[2], web: `https://github.com/${m[1]}/${m[2]}` } : { url }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/
const cmpVer = (a, b) => {
  const x = a.match(SEMVER).slice(1).map(Number)
  const y = b.match(SEMVER).slice(1).map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

// Where a project's version comes from, in order of trust: a release tag is a
// decision to ship, a manifest version may be ahead of any release.
function versionOf(dir) {
  if (existsSync(join(dir, '.git'))) {
    const tags = git(dir, 'tag', '--list').split('\n').filter((t) => SEMVER.test(t)).sort(cmpVer)
    if (tags.length) return { ver: tags.at(-1).replace(/^v/, ''), from: `tag ${tags.at(-1)}` }
  }
  const pkg = join(dir, 'package.json')
  if (existsSync(pkg)) {
    try {
      const v = JSON.parse(readFileSync(pkg, 'utf8')).version
      if (v && SEMVER.test(v)) return { ver: v, from: 'package.json' }
    } catch {}
  }
  const cargo = join(dir, 'Cargo.toml')
  if (existsSync(cargo)) {
    const m = readFileSync(cargo, 'utf8').match(/\[package\][^[]*?\nversion\s*=\s*"([^"]+)"/)
    if (m && SEMVER.test(m[1])) return { ver: m[1], from: 'Cargo.toml' }
  }
  return null
}

// Interface text has no em or en dashes (webdesign-lab RULES.md section 5).
const plain = (s) => s.replace(/\s*[—–]\s*/g, ': ').replace(/\s+/g, ' ').trim()

function describe(dir) {
  for (const f of ['package.json']) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')).description
      if (d) return plain(d)
    } catch {}
  }
  try {
    const m = readFileSync(join(dir, 'Cargo.toml'), 'utf8').match(/\ndescription\s*=\s*"([^"]+)"/)
    if (m) return plain(m[1])
  } catch {}
  let text
  try { text = readFileSync(join(dir, 'README.md'), 'utf8') } catch { return '' }
  // The first paragraph of prose: not a heading, a badge, a list, a table,
  // a quote, a fence or a line that is only emphasis.
  const para = text.replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).find((b) =>
    b && !/^(#|!\[|\[!\[|[-*+] |\d+\. |\||>|```|<)/.test(b) && !/^\*\*[^*]+\*\*\.?$/.test(b))
  if (!para) return ''
  const prose = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
  const sentence = plain(prose).match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain(prose)
  const s = sentence.replace(/[.]$/, '')
  if (s.length <= 90) return s
  return s.slice(0, s.lastIndexOf(' ', 89)).replace(/[,;:]$/, '') + '…'
}

const repoPublic = new Map()
async function isPublic(web) {
  if (OFFLINE) return false
  if (!repoPublic.has(web)) {
    let ok = false
    try {
      const r = await fetch(web, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) })
      ok = r.status === 200
    } catch {}
    repoPublic.set(web, ok)
  }
  return repoPublic.get(web)
}

const sameUrl = (a, b) => a.replace(/\.git$|\/$/g, '').toLowerCase() === b.replace(/\.git$|\/$/g, '').toLowerCase()

// --- scan ------------------------------------------------------------------

async function scan(data) {
  const root = rootDir(data)
  const changes = []
  const notes = []
  const owners = new Set(data.owners ?? [])
  const tracked = new Map()
  for (const { p } of allProjects(data)) for (const d of p.dirs ?? []) tracked.set(d, p)

  for (const [d, p] of [...tracked].sort(([a], [b]) => a.localeCompare(b))) {
    if (!existsSync(join(root, d))) notes.push(`missing   ${d} (listed under ${p.name})`)
  }

  // Updates to listed projects.
  for (const { p } of allProjects(data)) {
    const dirs = (p.dirs ?? []).filter((d) => existsSync(join(root, d)))
    if (dirs[0] && dirs[0] === (p.dirs ?? [])[0] && p.verFrom !== false) {
      const v = versionOf(join(root, dirs[0]))
      if (v && v.ver !== p.ver) {
        changes.push({ kind: 'version', text: `version   ${p.name} ${p.ver ?? '(none)'} -> ${v.ver} (${v.from} in ${dirs[0]})`, apply: () => { p.ver = v.ver } })
      }
    }
    for (const d of dirs) {
      const o = originOf(join(root, d))
      if (!o?.web || !owners.has(o.owner)) continue
      if ((p.links ?? []).some(([, u]) => sameUrl(u, o.web))) continue
      if (changes.some((c) => c.kind === 'link' && c.p === p)) continue
      if (!(await isPublic(o.web))) continue
      changes.push({ kind: 'link', p, text: `link      ${p.name} + Repo ${o.web}`, apply: () => { p.links = [...(p.links ?? []), ['Repo', o.web]] } })
    }
  }

  // New projects.
  const names = readdirSync(root).filter((n) => {
    try { return statSync(join(root, n)).isDirectory() } catch { return false }
  }).sort()
  for (const n of names) {
    if (tracked.has(n) || n === '.' || n.startsWith('.')) continue
    const dir = join(root, n)
    const why =
      data.ignore?.[n] ? `ignored: ${data.ignore[n]}` :
      !/^[A-Za-z0-9._-]+$/.test(n) ? 'not a plain name' :
      !existsSync(join(dir, 'README.md')) ? 'no README.md' :
      (() => { const o = originOf(dir); return o && (!o.owner || !owners.has(o.owner)) ? `origin is ${o.url}` : '' })()
    if (why) { notes.push(`skipped   ${n} (${why})`); continue }

    const rule = (data.placement ?? []).find((r) => new RegExp(r.match).test(n))
    const section = data.sections.find((s) => s.id === rule?.section) ?? data.sections.at(-1)
    const status = MANIFESTS.some((m) => existsSync(join(dir, m))) ? 'prototype' : 'research'
    const entry = { name: n, what: describe(dir) || n, status, dirs: [n], links: [] }
    const v = versionOf(dir)
    if (v) entry.ver = v.ver
    const o = originOf(dir)
    if (o?.web && (await isPublic(o.web))) entry.links.push(['Repo', o.web])
    changes.push({
      kind: 'new',
      text: `new       ${n} -> ${section.title}, ${LABELS[status]}${v ? `, ${v.ver}` : ''}: "${entry.what}"`,
      apply: () => section.projects.push(entry),
    })
  }
  return { changes, notes }
}

// --- render ----------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function renderRows(data) {
  const out = []
  for (const s of data.sections) {
    out.push('      <section>', `        <h2>${esc(s.title)}</h2>`, '        <ul class="rows">')
    for (const p of s.projects) {
      const ver = p.ver ? ` <span class="ver">${esc(p.ver)}</span>` : ''
      out.push(
        '          <li class="row">',
        `            <span class="name">${esc(p.name)}${ver}</span>`,
        `            <span class="what">${esc(p.what)}</span>`,
        `            <span class="status" data-s="${p.status}">${LABELS[p.status]}</span>`,
      )
      // Empty must be truly empty: the phone layout hides .links:empty.
      if (!p.links?.length) out.push('            <span class="links"></span>')
      else {
        out.push('            <span class="links">')
        for (const [label, url] of p.links) out.push(`              <a href="${esc(url)}">${esc(label)}</a>`)
        out.push('            </span>')
      }
      out.push('          </li>')
    }
    out.push('        </ul>', '      </section>')
  }
  return out
}

function renderHtml(data, html) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n'
  const a = html.indexOf(BEGIN)
  const b = html.indexOf(END)
  if (a < 0 || b < a) fail(`${HTML_PATH} lacks the ${BEGIN} ... ${END} markers`)
  const lineStart = html.lastIndexOf('\n', b) + 1
  return html.slice(0, a + BEGIN.length) + eol + renderRows(data).join(eol) + eol + html.slice(lineStart)
}

function render(data) {
  const html = readFileSync(HTML_PATH, 'utf8')
  const next = renderHtml(data, html)
  if (next !== html) writeFileSync(HTML_PATH, next)
  return next !== html
}

// --- verify ----------------------------------------------------------------

function checkData(data) {
  const errs = []
  const seen = new Set()
  const dirs = new Map()
  if (!data.sections?.length) errs.push('no sections')
  for (const s of data.sections ?? []) {
    if (!s.projects?.length) errs.push(`section "${s.title}" is empty`)
    for (const p of s.projects ?? []) {
      const at = `${s.title} / ${p.name}`
      if (!p.name || !p.what) errs.push(`${at}: name and what are required`)
      if (seen.has(p.name)) errs.push(`${at}: name used twice`)
      seen.add(p.name)
      if (!LABELS[p.status] || !data.statuses.includes(p.status)) errs.push(`${at}: status "${p.status}" is not one of ${data.statuses.join(', ')}`)
      if (p.ver && !SEMVER.test(p.ver)) errs.push(`${at}: version "${p.ver}" is not X.Y.Z`)
      for (const t of [p.name, p.what, ...(p.links ?? []).map((l) => l[0])]) {
        if (/[—–]/.test(t)) errs.push(`${at}: dash in "${t}"`)
      }
      for (const l of p.links ?? []) {
        if (!Array.isArray(l) || l.length !== 2 || !l[0]) errs.push(`${at}: a link is [label, url]`)
        else if (!/^https:\/\/[^\s"<>]+$/.test(l[1])) errs.push(`${at}: link "${l[1]}" is not an https URL`)
      }
      for (const d of p.dirs ?? []) {
        if (dirs.has(d)) errs.push(`${at}: dir ${d} is also under ${dirs.get(d)}`)
        if (data.ignore?.[d]) errs.push(`${at}: dir ${d} is also in ignore`)
        dirs.set(d, p.name)
      }
    }
  }
  return errs
}

const rowsOf = (html) => (html.match(/<li class="row">[\s\S]*?<\/li>/g) ?? []).map((r) => r.replace(/\s+/g, ' '))

async function checkLinks(data) {
  const urls = [...new Set(allProjects(data).flatMap(({ p }) => (p.links ?? []).map((l) => l[1])))].sort()
  const bad = []
  const queue = [...urls]
  const one = async (u) => {
    let last = ''
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'zenon.foo projects check' } })
        if (r.status < 400) return
        last = `HTTP ${r.status}`
        if (r.status === 404) break
      } catch (e) {
        last = e.cause?.code ?? e.name
      }
      await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)))
    }
    bad.push(`${u}: ${last}`)
  }
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await one(queue.shift()) }))
  return { count: urls.length, bad: bad.sort() }
}

async function verify(data) {
  const errs = checkData(data)
  if (errs.length) fail('data:\n  ' + errs.join('\n  '))
  log('ok  data: %d projects in %d sections', allProjects(data).length, data.sections.length)

  const html = readFileSync(HTML_PATH, 'utf8')
  const rendered = renderHtml(data, html)
  if (rendered !== html) fail('projects/index.html is not what projects.json renders to; run render')
  if (renderHtml(data, rendered) !== rendered) fail('render is not idempotent')
  log('ok  render: index.html matches projects.json')

  // One string through the shell: npm is npm.cmd on Windows, which Node will
  // not spawn without a shell, and it warns when given args alongside one.
  const build = spawnSync('npm run build', { cwd: REPO, encoding: 'utf8', shell: true })
  if (build.status !== 0) fail('build failed:\n' + (build.stdout + build.stderr).split('\n').slice(-30).join('\n'))
  log('ok  build')

  const dist = readFileSync(DIST_HTML, 'utf8')
  const rows = rowsOf(dist)
  if (rows.length !== allProjects(data).length) fail(`dist has ${rows.length} rows, projects.json has ${allProjects(data).length}`)
  const srcRows = rowsOf(rendered)
  rows.forEach((r, i) => { if (r !== srcRows[i]) fail(`dist row ${i + 1} differs from the source:\n  ${r}\n  ${srcRows[i]}`) })
  for (const ref of dist.match(/(?:href|src)="\/assets\/[^"]+"/g) ?? []) {
    const path = ref.replace(/^[a-z]+="\//, '').replace(/"$/, '')
    if (!existsSync(join(REPO, 'dist', path))) fail(`dist references ${path}, which was not built`)
  }
  if (!/href="\/assets\/[^"]+\.css"/.test(dist)) fail('dist/projects/index.html links no stylesheet')
  log('ok  dist: %d rows, stylesheet present', rows.length)

  if (OFFLINE) log('--  links: skipped (--offline)')
  else {
    const { count, bad } = await checkLinks(data)
    if (bad.length) fail('links that do not answer:\n  ' + bad.join('\n  '))
    log('ok  links: %d answer', count)
  }
  return rows
}

// --- deploy ----------------------------------------------------------------

function summarize(before, after) {
  const index = (d) => new Map(allProjects(d).map(({ section, p }) => [p.name, { section: section.title, p }]))
  const a = before ? index(before) : new Map()
  const b = index(after)
  const parts = []
  const added = [...b.keys()].filter((n) => !a.has(n))
  const removed = [...a.keys()].filter((n) => !b.has(n))
  const moved = [...b.keys()].filter((n) => a.has(n) && a.get(n).section !== b.get(n).section)
  const vers = [...b.keys()].filter((n) => a.has(n) && a.get(n).p.ver !== b.get(n).p.ver)
  if (added.length) parts.push(`add ${added.join(', ')}`)
  if (removed.length) parts.push(`remove ${removed.join(', ')}`)
  if (moved.length) parts.push(`move ${moved.map((n) => `${n} to ${b.get(n).section}`).join(', ')}`)
  if (vers.length) parts.push(`${vers.map((n) => `${n} ${b.get(n).p.ver ?? 'unversioned'}`).join(', ')}`)
  const subject = parts.length ? 'Projects: ' + parts.join('; ') : 'Projects: update the index'
  return subject.length <= 72 ? { subject, body: '' } : { subject: 'Projects: update the index', body: parts.map((p) => '- ' + p).join('\n') }
}

async function deploy(data) {
  const before = (() => { try { return JSON.parse(git(REPO, 'show', 'HEAD:projects/projects.json')) } catch { return null } })()
  const dirty = git(REPO, 'status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3))
  const outside = dirty.filter((f) => !f.startsWith('projects/'))
  if (outside.length) fail('uncommitted changes outside projects/ would not be deployed; commit or stash them:\n  ' + outside.join('\n  '))
  git(REPO, 'fetch', 'origin')
  const branch = git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'master') fail(`on ${branch}; Pages deploys from master`)
  if (git(REPO, 'rev-list', '--count', 'HEAD..origin/master') !== '0') fail('master is behind origin/master; pull first')

  const rows = await verify(data)
  const changed = git(REPO, 'status', '--porcelain', '--', 'projects').length > 0
  const ahead = git(REPO, 'rev-list', '--count', 'origin/master..HEAD') !== '0'
  if (!changed && !ahead) {
    log('--  nothing to deploy; checking the live page')
    return checkLive(data, rows, 1)
  }
  if (DRY) { log('--  dry run: stopping before the commit'); return }

  if (changed) {
    const { subject, body } = summarize(before, data)
    git(REPO, 'add', '--', 'projects/index.html', 'projects/projects.json')
    const msg = [subject, body, 'Generated by scripts/projects.mjs.'].filter(Boolean).join('\n\n')
    execFileSync('git', ['-C', REPO, 'commit', '-q', '-F', '-'], { input: msg })
    log('ok  commit: %s', subject)
  }
  const sha = git(REPO, 'rev-parse', 'HEAD')
  execFileSync('git', ['-C', REPO, 'push', 'origin', 'master'], { stdio: 'inherit' })
  log('ok  push: %s', sha.slice(0, 7))

  await waitForRun(data, sha)
  await checkLive(data, rows, 30)
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

async function waitForRun(data, sha) {
  const api = `https://api.github.com/repos/${data.repo}/actions/runs?head_sha=${sha}&per_page=5`
  for (let i = 0; i < 45; i++) {
    const r = await fetch(api, { headers: { accept: 'application/vnd.github+json' } }).catch(() => null)
    const run = r?.ok ? (await r.json()).workflow_runs?.[0] : null
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') fail(`Pages run ${run.conclusion}: ${run.html_url}`)
      log('ok  pages run: %s', run.html_url)
      return
    }
    await sleep(20000)
  }
  fail(`no completed Pages run for ${sha.slice(0, 7)} after 15 minutes`)
}

async function checkLive(data, rows, tries) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${data.liveUrl}?v=${Date.now()}`, { redirect: 'follow' }).catch(() => null)
    const live = r?.ok ? rowsOf(await r.text()) : []
    if (live.length === rows.length && live.every((x, j) => x === rows[j])) {
      log('ok  live: %s serves all %d rows', data.liveUrl, rows.length)
      return
    }
    if (i < tries - 1) await sleep(20000)
  }
  fail(`${data.liveUrl} does not serve the built rows`)
}

// --- main ------------------------------------------------------------------

async function main() {
  const data = load()
  if (cmd === 'render') {
    log(render(data) ? 'rendered projects/index.html' : 'projects/index.html already current')
    return
  }
  if (cmd === 'verify') return void (await verify(data))
  if (!['scan', 'update', 'deploy'].includes(cmd)) fail(`unknown command ${cmd}; use scan, update, render, verify or deploy`)

  const { changes, notes } = await scan(data)
  if (args.includes('--verbose') || cmd === 'scan') for (const n of notes) log(n)
  for (const c of changes) log(c.text)
  if (!changes.length) log('no changes from the tree')
  if (cmd === 'scan') return

  for (const c of changes) c.apply()
  save(data)
  log(render(data) ? 'rendered projects/index.html' : 'projects/index.html already current')
  if (cmd === 'deploy') await deploy(load())
}

main().catch((e) => {
  console.error(e instanceof Fail ? 'FAIL ' + e.message : e)
  process.exit(1)
})
