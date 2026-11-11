#!/usr/bin/env node
// Generates the "GitHub Activity" SVG cards for the profile README:
//
//   assets/stats.svg          - key metrics (contributions, commits, PRs, ...)
//   assets/languages.svg      - most used languages across public repos
//   assets/contributions.svg  - 12-month contribution heatmap
//
// Everything is rendered locally in the portfolio's brand palette
// (sea-ink background, orange accent, lagoon teal) - no third-party
// image services involved, so the cards can never 503 like
// github-readme-stats.vercel.app did.
//
// Pure Node (>= 18), no dependencies. Uses the public GitHub REST and
// GraphQL APIs; set GITHUB_TOKEN to lift the rate limit (optional):
//
//   node scripts/generate-stats-cards.mjs

import dns from 'node:dns'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const USER = 'elarfaoui-ala'
const ASSETS = path.join(process.cwd(), 'assets')
const API = 'https://api.github.com'
const TOKEN = process.env.GITHUB_TOKEN || ''

const BASE_HEADERS = {
  'User-Agent': 'elarfaoui-ala-profile-stats',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
}

// --- Brand tokens (keep in sync with assets/banner.svg) ------------------------

const C = {
  bgFrom: '#1C444D',
  bgTo: '#0F252A',
  panel: '#0C1F24',
  accent: '#F97316',
  lagoon: '#4FB8B2',
  light: '#D7ECE8',
}

const SERIF = "Georgia, 'Times New Roman', serif"
const SANS = "'Segoe UI', Arial, sans-serif"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Some networks let DNS resolve api.github.com to a NAT64 IPv6 address whose
// TCP connect then hangs until undici's 10s timeout; preferring A records
// avoids that. Network-level failures are also retried below.
dns.setDefaultResultOrder('ipv4first')

// fetch() throws TypeError("fetch failed") for any transport-level problem
// (connect timeout, reset, DNS, ...). Those are transient - retry them.
async function httpFetch(url, options = {}, { retries = 4, backoffMs = 1500 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options)
    } catch (error) {
      lastError = error
      const code = error?.cause?.code ?? error?.cause?.cause?.code ?? ''
      const transient =
        error instanceof TypeError ||
        ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
      if (!transient) throw error
      console.warn(`warn: fetch ${url.slice(0, 60)} failed (${code || 'network'}), retry ${attempt + 1}/${retries}`)
    }
    if (attempt < retries) await sleep(backoffMs * (attempt + 1))
  }
  throw lastError
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const fmt = (value) =>
  typeof value === 'number' ? value.toLocaleString('en-US') : value

// --- GitHub API helpers --------------------------------------------------------

async function rest(pathname, { retries = 1, backoffMs = 4000 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await httpFetch(`${API}${pathname}`, { headers: BASE_HEADERS })
    if (res.status === 204) {
      // Contributor-stats endpoints answer 204 while GitHub computes them.
      lastError = new Error(`GET ${pathname} -> 204 (computing)`)
    } else if (res.status === 403 || res.status >= 500) {
      lastError = new Error(`GET ${pathname} -> ${res.status}`)
    } else if (!res.ok) {
      throw new Error(`GET ${pathname} -> ${res.status} ${res.statusText}`)
    } else {
      return res.json()
    }
    if (attempt < retries) await sleep(backoffMs)
  }
  console.warn(`warn: ${lastError.message} (skipping)`)
  return null
}

async function graphql(query) {
  const res = await httpFetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`POST /graphql -> ${res.status}`)
  const body = await res.json()
  if (body.errors) {
    throw new Error(`GraphQL: ${body.errors[0]?.message ?? 'unknown error'}`)
  }
  return body.data
}

async function searchCount(kind) {
  const q = encodeURIComponent(`author:${USER} is:${kind}`)
  const data = await rest(`/search/issues?q=${q}&per_page=1`)
  return data?.total_count ?? 0
}

// --- Contribution calendar (exact counts via GraphQL, scrape fallback) ---------

const CALENDAR_QUERY = `{
  viewer {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          firstDay
          contributionDays { date contributionCount }
        }
      }
    }
  }
}`

async function calendarViaGraphql() {
  const data = await graphql(CALENDAR_QUERY)
  const viewer = data?.viewer
  const calendar = viewer?.contributionsCollection?.contributionCalendar
  if (viewer?.login !== USER || !calendar?.weeks?.length) {
    throw new Error('contributionsCollection not available for this token')
  }
  return {
    weeks: calendar.weeks,
    total: calendar.totalContributions,
    approximate: false,
  }
}

// Fallback: the public contributions page embeds each day as
// <td ... data-date="YYYY-MM-DD" ... data-level="0-4" ...> with one
// <tr> per week - enough to draw the heatmap (levels, not exact counts)
// when the token cannot use GraphQL.
async function calendarViaScrape() {
  const res = await httpFetch(`https://github.com/users/${USER}/contributions`, {
    headers: { 'User-Agent': 'elarfaoui-ala-profile-stats' },
  })
  if (!res.ok) throw new Error(`contributions page -> ${res.status}`)
  const html = await res.text()
  const weeks = []
  for (const row of html.split('<tr').slice(1)) {
    const days = [...row.matchAll(
      /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d+)"/g,
    )].map((match) => ({
      date: match[1],
      contributionCount: Number(match[2]),
    }))
    if (days.length) weeks.push({ firstDay: days[0].date, contributionDays: days })
  }
  if (!weeks.length) throw new Error('no day cells found on contributions page')
  return { weeks, total: null, approximate: true }
}

// --- Rendering -----------------------------------------------------------------

function svgDoc(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${body}</svg>\n`
}

function frame(width, height, title) {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bgFrom}"/>
      <stop offset="1" stop-color="${C.bgTo}"/>
    </linearGradient>
    <radialGradient id="glowO" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.14"/>
      <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowT" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.lagoon}" stop-opacity="0.1"/>
      <stop offset="1" stop-color="${C.lagoon}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="${C.lagoon}" fill-opacity="0.1"/>
    </pattern>
  </defs>
  <rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="16" fill="url(#bg)" stroke="${C.lagoon}" stroke-opacity="0.35" stroke-width="2"/>
  <rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="16" fill="url(#dots)"/>
  <circle cx="${width - 60}" cy="50" r="130" fill="url(#glowO)"/>
  <circle cx="60" cy="${height - 40}" r="110" fill="url(#glowT)"/>
  <text x="24" y="40" font-family="${SERIF}" font-size="20" font-weight="700" fill="${C.light}">${esc(title)}</text>
  <rect x="24" y="50" width="40" height="5" rx="2.5" fill="${C.accent}"/>`
}

// Icons drawn in a 22x22 box at (0,0).
const ICONS = {
  heat: `<g fill="${C.lagoon}">
    <rect x="0" y="0" width="5.5" height="5.5" rx="1.2" fill-opacity="0.3"/>
    <rect x="8.25" y="0" width="5.5" height="5.5" rx="1.2" fill-opacity="0.6"/>
    <rect x="16.5" y="0" width="5.5" height="5.5" rx="1.2" fill-opacity="0.45"/>
    <rect x="0" y="8.25" width="5.5" height="5.5" rx="1.2" fill-opacity="0.75"/>
    <rect x="8.25" y="8.25" width="5.5" height="5.5" rx="1.2" fill="${C.accent}"/>
    <rect x="16.5" y="8.25" width="5.5" height="5.5" rx="1.2" fill-opacity="0.55"/>
    <rect x="0" y="16.5" width="5.5" height="5.5" rx="1.2" fill-opacity="0.4"/>
    <rect x="8.25" y="16.5" width="5.5" height="5.5" rx="1.2" fill-opacity="0.85"/>
    <rect x="16.5" y="16.5" width="5.5" height="5.5" rx="1.2" fill-opacity="0.5"/>
  </g>`,
  commit: `<g fill="none" stroke="${C.lagoon}" stroke-width="1.8" stroke-linecap="round">
    <line x1="1" y1="11" x2="6.5" y2="11"/>
    <line x1="15.5" y1="11" x2="21" y2="11"/>
    <circle cx="11" cy="11" r="4" fill="${C.bgTo}"/>
  </g>`,
  pr: `<g fill="none" stroke="${C.lagoon}" stroke-width="1.8" stroke-linecap="round">
    <circle cx="5" cy="5.5" r="3"/>
    <circle cx="5" cy="16.5" r="3"/>
    <path d="M 8 5.5 h 5.5 a 5 5 0 0 1 5 5 v 1"/>
    <circle cx="18.5" cy="16.5" r="3"/>
  </g>`,
  issue: `<g fill="none" stroke="${C.lagoon}" stroke-width="1.8">
    <circle cx="11" cy="11" r="8.25"/>
    <circle cx="11" cy="11" r="2" fill="${C.lagoon}" stroke="none"/>
  </g>`,
  star: `<path d="M 11 1.5 L 13.7 7.9 L 20.6 8.5 L 15.5 13 L 17 19.8 L 11 16.4 L 5 19.8 L 6.5 13 L 1.4 8.5 L 8.3 7.9 Z"
    fill="none" stroke="${C.lagoon}" stroke-width="1.8" stroke-linejoin="round"/>`,
  person: `<g fill="none" stroke="${C.lagoon}" stroke-width="1.8" stroke-linecap="round">
    <circle cx="11" cy="6.5" r="3.75"/>
    <path d="M 4 20 a 7 7 0 0 1 14 0"/>
  </g>`,
}

function renderStatsCard(metrics) {
  const W = 495
  const H = 200
  const cols = [24, 258]
  const rows = [88, 130, 172]
  const cells = metrics
    .map((metric, index) => {
      const x = cols[index % 2]
      const y = rows[Math.floor(index / 2)]
      return `
  <g transform="translate(${x}, ${y - 18})">${ICONS[metric.icon]}</g>
  <text x="${x + 34}" y="${y}" font-family="${SANS}" font-size="20" font-weight="700" fill="${C.accent}">${fmt(metric.value)}</text>
  <text x="${x + 34}" y="${y + 17}" font-family="${SANS}" font-size="10.5" fill="${C.light}" fill-opacity="0.65">${esc(metric.label)}</text>`
    })
    .join('')
  return svgDoc(W, H, `${frame(W, H, "Ala's GitHub Stats")}${cells}`)
}

function renderLanguagesCard(languages) {
  const W = 495
  const H = 200
  const rows = languages
    .map((lang, index) => {
      const y = 78 + index * 25
      const color = index === 0 ? C.accent : C.lagoon
      const barWidth = Math.max(2, (443 * lang.pct) / 100).toFixed(1)
      return `
  <text x="24" y="${y}" font-family="${SANS}" font-size="12.5" font-weight="600" fill="${C.light}">${esc(lang.name)}</text>
  <text x="471" y="${y}" text-anchor="end" font-family="${SANS}" font-size="12.5" font-weight="700" fill="${color}">${lang.pct.toFixed(1)}%</text>
  <rect x="24" y="${y + 6}" width="443" height="6" rx="3" fill="${C.panel}" stroke="${C.light}" stroke-opacity="0.12"/>
  <rect x="24" y="${y + 6}" width="${barWidth}" height="6" rx="3" fill="${color}" fill-opacity="0.95"/>`
    })
    .join('')
  const empty = languages.length
    ? ''
    : `
  <text x="24" y="90" font-family="${SANS}" font-size="13" fill="${C.light}" fill-opacity="0.6">No public code yet</text>`
  return svgDoc(W, H, `${frame(W, H, 'Most Used Languages')}${rows}${empty}`)
}

function renderContributionsCard(calendar) {
  const W = 752
  const H = 200
  const CELL = 10
  const GAP = 3
  const STEP = CELL + GAP
  const X0 = 24
  const Y0 = 76
  const weeks = calendar.weeks.slice(-53)
  const maxCount = Math.max(
    1,
    ...weeks.flatMap((week) =>
      week.contributionDays.map((day) => day.contributionCount),
    ),
  )

  const cells = weeks
    .map((week, weekIndex) =>
      week.contributionDays
        .map((day, dayIndex) => {
          const x = X0 + weekIndex * STEP
          const y = Y0 + dayIndex * STEP
          const count = day.contributionCount
          if (!count) {
            return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${C.lagoon}" fill-opacity="0.1"/>`
          }
          const isPeak = count === maxCount && maxCount > 1
          const opacity = Math.min(0.95, 0.4 + (0.55 * count) / maxCount).toFixed(2)
          return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${isPeak ? C.accent : C.lagoon}" fill-opacity="${opacity}"/>`
        })
        .join(''),
    )
    .join('')

  // Month labels at the first week that contains the 1st-7th of a month.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  let lastMonth = -1
  const monthLabels = []
  weeks.forEach((week, weekIndex) => {
    const firstDay = week.contributionDays[0]?.date ?? week.firstDay
    if (!firstDay) return
    const month = Number(firstDay.slice(5, 7)) - 1
    const dayOfMonth = Number(firstDay.slice(8, 10))
    if (month !== lastMonth && (weekIndex === 0 || dayOfMonth <= 7)) {
      const x = X0 + weekIndex * STEP
      if (x < W - 34) {
        monthLabels.push(
          `<text x="${x}" y="66" font-family="${SANS}" font-size="9.5" fill="${C.light}" fill-opacity="0.55">${MONTHS[month]}</text>`,
        )
      }
      lastMonth = month
    }
  })

  const headerRight = `
  <text x="${W - 24}" y="40" text-anchor="end" font-family="${SANS}" font-size="12.5" fill="${C.light}" fill-opacity="0.85">${
    calendar.total != null
      ? `<tspan font-weight="700" fill="${C.accent}">${fmt(calendar.total)}</tspan> contributions in the last year`
      : 'contributions in the last year'
  }</text>`

  const swatches = [0.1, 0.3, 0.5, 0.7, 0.95]
    .map((opacity, index) => `<rect x="${56 + index * 13}" y="178" width="10" height="10" rx="2" fill="${index === 4 ? C.accent : C.lagoon}" fill-opacity="${opacity}"/>`)
    .join('')
  const legend = `
  <text x="24" y="187" font-family="${SANS}" font-size="9.5" fill="${C.light}" fill-opacity="0.55">Less</text>${swatches}
  <text x="127" y="187" font-family="${SANS}" font-size="9.5" fill="${C.light}" fill-opacity="0.55">More</text>`

  return svgDoc(
    W,
    H,
    `${frame(W, H, 'Contribution Activity')}${headerRight}${monthLabels.join('')}${cells}${legend}`,
  )
}

// --- Main ----------------------------------------------------------------------

async function main() {
  console.log(`Fetching GitHub data for ${USER}...`)

  const [user, repos, prCount, issueCount] = await Promise.all([
    rest(`/users/${USER}`),
    rest(`/users/${USER}/repos?per_page=100`),
    searchCount('pr'),
    searchCount('issue'),
  ])
  if (!user || !Array.isArray(repos)) {
    throw new Error('could not load user / repository data')
  }

  const ownRepos = repos.filter((repo) => !repo.fork)

  // Languages: byte totals across all public, non-fork repositories.
  const languageTotals = {}
  for (const repo of ownRepos) {
    const languages = await rest(`/repos/${USER}/${repo.name}/languages`, { retries: 1 })
    if (!languages || Array.isArray(languages)) continue
    for (const [name, bytes] of Object.entries(languages)) {
      languageTotals[name] = (languageTotals[name] || 0) + bytes
    }
  }
  const allBytes = Object.values(languageTotals).reduce((sum, bytes) => sum + bytes, 0)
  const topLanguages = Object.entries(languageTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, bytes]) => ({ name, pct: allBytes ? (bytes / allBytes) * 100 : 0 }))

  // Commits on default branches, via the contributor-stats endpoint.
  let commits = 0
  for (const repo of ownRepos) {
    const stats = await rest(`/repos/${USER}/${repo.name}/stats/contributors`, {
      retries: 3,
      backoffMs: 8000,
    })
    if (!Array.isArray(stats)) continue
    for (const contributor of stats) {
      if (contributor?.author?.login === USER) commits += contributor.total ?? 0
    }
  }

  // Contribution calendar.
  let calendar
  try {
    calendar = await calendarViaGraphql()
    console.log('calendar: GraphQL (exact counts)')
  } catch (error) {
    console.warn(`GraphQL calendar unavailable (${error.message}) - scraping public page`)
    calendar = await calendarViaScrape()
    console.log('calendar: scraped page (approximate levels)')
  }

  const stars = ownRepos.reduce(
    (sum, repo) => sum + (repo.stargazers_count ?? 0),
    0,
  )

  const metrics = [
    { label: 'Contributions last year', value: calendar.total ?? '—', icon: 'heat' },
    { label: 'Commits on public repos', value: commits, icon: 'commit' },
    { label: 'Pull requests', value: prCount, icon: 'pr' },
    { label: 'Issues opened', value: issueCount, icon: 'issue' },
    { label: 'Stars earned', value: stars, icon: 'star' },
    { label: 'Followers', value: user.followers, icon: 'person' },
  ]

  const cards = [
    ['stats.svg', renderStatsCard(metrics)],
    ['languages.svg', renderLanguagesCard(topLanguages)],
    ['contributions.svg', renderContributionsCard(calendar)],
  ]

  await mkdir(ASSETS, { recursive: true })
  for (const [name, content] of cards) {
    await writeFile(path.join(ASSETS, name), content, 'utf8')
    console.log(`wrote assets/${name} (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`)
  }
  console.log(`metrics: ${metrics.map((m) => `${m.label}=${fmt(m.value)}`).join(' | ')}`)
  console.log(`languages: ${topLanguages.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(' | ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
