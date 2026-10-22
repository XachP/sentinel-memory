// The three learning loops. Pure functions over MemoryState, which is the agent's long-term memory. The CLI writes
// a snapshot of it to Walrus Memory every run and recalls it at the start of the next run.
//   Loop 1, feed reliability: which price feeds agree with the crowd and are fresh. Unreliable feeds leave the consensus.
//   Loop 2, argument credibility: each bull/bear argument is a forecast and is checked after `horizonSec`.
//   Loop 3, regret: past WATCH alerts are scored as justified or false alarms, past HOLDs as fine or missed.
//           The result moves the alert margin within the policy's bounds.
import { hashCanonical } from './canonical'
import type { Evidence, Quote } from './evidence'
import { absBps, bpsDiff, clamp, median } from './math'
import { SOURCES, type Policy, type SourceId } from './policy'

export const STATE_SCHEMA = 'sentinel-memory/state/v1'

export type FeedOutcome = 'agree' | 'deviate' | 'stale' | 'error'
export type SourceTrust = { a: number; b: number; n: number; trustBps: number; muted: boolean; last: FeedOutcome; lastDevBps: number }
export type VoiceCred = { side: 'bull' | 'bear'; a: number; b: number; n: number; credBps: number; multiplierBps: number; lastResult: 'right' | 'wrong' | 'none' }
export type ForecastKind = 'gap_holds' | 'gap_shrinks' | 'price_up' | 'price_down'
export type AlertKind = 'HOLD' | 'WATCH' | 'ESCALATE'
/** One run's checkable claims: the arguments each obligation's agents made, and what the judge did. */
export type Pending = {
	seq: number
	madeAt: number
	dueAt: number
	priceMicros: number
	items: { obligationId: string; gapBps: number; healthBps: number; action: AlertKind; args: string[] }[]
}
export type RegretOutcome = 'justified' | 'false_alarm' | 'ok' | 'missed'
export type MemoryState = {
	schema: typeof STATE_SCHEMA
	seq: number
	updatedAt: number
	prevStateHash: string
	sources: Partial<Record<SourceId, SourceTrust>>
	voices: Record<string, VoiceCred>
	pending: Pending[]
	regret: RegretOutcome[] // most recent last, capped at policy.memory.regretWindow
	marginPoints: number
	lastConsensusMicros: number
	lastConsensusAt: number
	lastRisk: Record<string, { gapBps: number; healthBps: number; at: number }> // last reading per obligation
}

export function emptyState(p: Policy): MemoryState {
	return {
		schema: STATE_SCHEMA,
		seq: 0,
		updatedAt: 0,
		prevStateHash: '0x',
		sources: {},
		voices: {},
		pending: [],
		regret: [],
		marginPoints: p.judge.watchMarginPoints,
		lastConsensusMicros: 0,
		lastConsensusAt: 0,
		lastRisk: {},
	}
}

export const stateHash = (s: MemoryState) => hashCanonical(s)

// ---------- Loop 1: feed reliability ----------

const quoteAge = (q: Quote, now: number) => now - q.ts
const maxAge = (q: Quote, p: Policy) => (q.source === 'suilend_oracle' ? p.dataQuality.maxOracleAgeSec : p.dataQuality.maxQuoteAgeSec)
export const isFresh = (q: Quote, now: number, p: Policy) => q.ok && quoteAge(q, now) <= maxAge(q, p) && quoteAge(q, now) >= -120

/** Grade every feed against the median of ALL fresh feeds. The reference is deliberately trust-blind, so a muted
 *  feed can earn its way back and a trusted feed cannot grade itself. */
export function gradeFeeds(e: Evidence, p: Policy): { referenceMicros: number; grades: Partial<Record<SourceId, { outcome: FeedOutcome; devBps: number }>> } {
	const fresh = e.quotes.filter((q) => isFresh(q, e.observedAt, p))
	const grades: Partial<Record<SourceId, { outcome: FeedOutcome; devBps: number }>> = {}
	const referenceMicros = fresh.length >= 2 ? median(fresh.map((q) => q.priceMicros)) : 0
	for (const q of e.quotes) {
		if (!q.ok) grades[q.source] = { outcome: 'error', devBps: 0 }
		else if (!isFresh(q, e.observedAt, p)) grades[q.source] = { outcome: 'stale', devBps: referenceMicros ? absBps(q.priceMicros, referenceMicros) : 0 }
		else if (referenceMicros === 0) continue // nothing to compare against: no verdict
		else {
			const dev = absBps(q.priceMicros, referenceMicros)
			grades[q.source] = { outcome: dev <= p.dataQuality.agreeBps ? 'agree' : 'deviate', devBps: dev }
		}
	}
	return { referenceMicros, grades }
}

function betaUpdate(a: number, b: number, hit: boolean, decayBps: number) {
	const na = Math.floor((a * decayBps) / 10000) + (hit ? 10000 : 0)
	const nb = Math.floor((b * decayBps) / 10000) + (hit ? 0 : 10000)
	return { a: na, b: nb, meanBps: Math.floor((na * 10000) / (na + nb)) }
}

export function newTrust(p: Policy): SourceTrust {
	const m = p.memory
	return { a: m.priorHits, b: m.priorMisses, n: 0, trustBps: Math.floor((m.priorHits * 10000) / (m.priorHits + m.priorMisses)), muted: false, last: 'agree', lastDevBps: 0 }
}

export function updateFeeds(prev: MemoryState['sources'], grades: ReturnType<typeof gradeFeeds>['grades'], p: Policy): MemoryState['sources'] {
	const next: MemoryState['sources'] = { ...prev }
	for (const s of SOURCES) {
		const g = grades[s]
		if (!g) continue
		const t = prev[s] ?? newTrust(p)
		const u = betaUpdate(t.a, t.b, g.outcome === 'agree', p.memory.decayBps)
		const n = t.n + 1
		let muted = t.muted
		if (n >= p.memory.minObservations) muted = t.muted ? u.meanBps < p.memory.unmuteAboveBps : u.meanBps < p.memory.muteBelowBps
		next[s] = { a: u.a, b: u.b, n, trustBps: u.meanBps, muted, last: g.outcome, lastDevBps: g.devBps }
	}
	return next
}

export type Consensus = { priceMicros: number; used: SourceId[]; excluded: { source: SourceId; reason: string }[] }

/** Consensus SUI/USD from the feeds memory still trusts. This is where recalled memory changes what the agent sees. */
export function consensus(e: Evidence, sources: MemoryState['sources'], p: Policy): Consensus {
	const used: SourceId[] = []
	const excluded: Consensus['excluded'] = []
	for (const q of e.quotes) {
		const t = sources[q.source]
		if (!q.ok) excluded.push({ source: q.source, reason: `error: ${q.detail.slice(0, 80)}` })
		else if (!isFresh(q, e.observedAt, p)) excluded.push({ source: q.source, reason: `stale: ${e.observedAt - q.ts}s old` })
		else if (t?.muted) excluded.push({ source: q.source, reason: `muted by memory: trust ${(t.trustBps / 100).toFixed(1)}% over ${t.n} runs` })
		else used.push(q.source)
	}
	const prices = e.quotes.filter((q) => used.includes(q.source)).map((q) => q.priceMicros)
	return { priceMicros: prices.length ? median(prices) : 0, used, excluded }
}

// ---------- Loop 2: argument credibility ----------

export function multiplierFor(v: VoiceCred | undefined, p: Policy): number {
	if (!v || v.n < p.memory.minResolutions) return 10000
	const m = p.memory
	return clamp(m.multiplierFloorBps + Math.floor(((m.multiplierCeilBps - m.multiplierFloorBps) * v.credBps) / 10000), m.multiplierFloorBps, m.multiplierCeilBps)
}

export type Resolution = { seq: number; obligationId: string; argId: string; kind: ForecastKind; right: boolean; detail: string }
export type AlertResolution = { seq: number; obligationId: string; action: AlertKind; outcome: RegretOutcome; detail: string }
export type Observation = { gapBps: Record<string, number>; healthBps: Record<string, number>; priceMicros: number; at: number }
export type RiskPoint = { gapBps: number; healthBps: number; priceMicros: number }
/** How much risk rose between two observations, in bps: the larger of the drop-to-liquidation shrink and the cover decline. */
export const riskRise = (base: RiskPoint, now: RiskPoint) => Math.max(base.gapBps - now.gapBps, Math.min(base.healthBps, 30000) - Math.min(now.healthBps, 30000))

export function judgeForecast(kind: ForecastKind, base: RiskPoint, now: RiskPoint, p: Policy): { right: boolean; detail: string } {
	if (kind === 'price_up' || kind === 'price_down') {
		const move = bpsDiff(now.priceMicros, base.priceMicros)
		const right = kind === 'price_up' ? move >= p.memory.priceFlatBps : move <= -p.memory.priceFlatBps
		return { right, detail: `SUI moved ${move} bps` }
	}
	const rise = riskRise(base, now)
	const right = kind === 'gap_shrinks' ? rise >= p.memory.forecastMoveBps : rise < p.memory.forecastMoveBps
	return { right, detail: `risk rose ${rise} bps (gap ${base.gapBps}->${now.gapBps}, cover ${base.healthBps}->${now.healthBps})` }
}

export function judgeAlert(action: AlertKind, base: RiskPoint, now: RiskPoint, p: Policy): RegretOutcome {
	const shrink = riskRise(base, now)
	if (action === 'HOLD') return shrink >= p.memory.missMoveBps ? 'missed' : 'ok'
	return shrink >= p.memory.forecastMoveBps ? 'justified' : 'false_alarm'
}

/** Loops 2 and 3: check every matured run against what the chain shows now. */
export function resolvePending(state: MemoryState, obs: Observation, forecastOf: (argId: string) => ForecastKind, p: Policy) {
	const voices = { ...state.voices }
	const pending: Pending[] = []
	const resolved: Resolution[] = []
	const alerts: AlertResolution[] = []
	for (const run of state.pending) {
		if (run.dueAt > obs.at) { pending.push(run); continue }
		if (!obs.priceMicros) {
			if (obs.at - run.dueAt < 2 * p.memory.horizonSec) pending.push(run) // no trusted price now: try next run
			continue
		}
		for (const it of run.items) {
			const g = obs.gapBps[it.obligationId]
			if (g === undefined) continue
			const base: RiskPoint = { gapBps: it.gapBps, healthBps: it.healthBps, priceMicros: run.priceMicros }
			const now: RiskPoint = { gapBps: g, healthBps: obs.healthBps[it.obligationId], priceMicros: obs.priceMicros } // obligation gone or not watched any more: void, not a verdict
			for (const argId of it.args) {
				const kind = forecastOf(argId)
				const v = judgeForecast(kind, base, now, p)
				const prev = voices[argId] ?? { side: argId.startsWith('B') ? ('bull' as const) : ('bear' as const), a: 10000, b: 10000, n: 0, credBps: 5000, multiplierBps: 10000, lastResult: 'none' as const }
				const u = betaUpdate(prev.a, prev.b, v.right, p.memory.decayBps)
				const nv: VoiceCred = { side: prev.side, a: u.a, b: u.b, n: prev.n + 1, credBps: u.meanBps, multiplierBps: 10000, lastResult: v.right ? 'right' : 'wrong' }
				nv.multiplierBps = multiplierFor(nv, p)
				voices[argId] = nv
				resolved.push({ seq: run.seq, obligationId: it.obligationId, argId, kind, right: v.right, detail: v.detail })
			}
			alerts.push({ seq: run.seq, obligationId: it.obligationId, action: it.action, outcome: judgeAlert(it.action, base, now, p), detail: `risk rose ${riskRise(base, now)} bps` })
		}
	}
	return { voices, pending, resolved, alerts }
}

export function marginFrom(regret: RegretOutcome[], p: Policy): number {
	const fa = regret.filter((r) => r === 'false_alarm').length
	const ju = regret.filter((r) => r === 'justified').length
	const mi = regret.filter((r) => r === 'missed').length
	const m = p.memory
	return clamp(p.judge.watchMarginPoints + m.regretStepPoints * (fa - ju) - 2 * m.regretStepPoints * mi, m.marginMinPoints, m.marginMaxPoints)
}
