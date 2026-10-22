// One agent cycle as a pure function: (recalled memory, fresh evidence, policy) -> (decisions, next memory, record).
// The CLI handles I/O (Tatum reads, Walrus recall/remember). Everything here is deterministic and replayable.
import { hashCanonical } from './canonical'
import { evidenceHash, type Evidence } from './evidence'
import { Action, judgePosition, type PositionDecision } from './judge'
import { forecastOf } from './agents'
import {
	consensus, emptyState, gradeFeeds, isFresh, marginFrom, resolvePending, riskRise, stateHash, updateFeeds,
	type AlertKind, type AlertResolution, type Consensus, type MemoryState, type Observation, type Pending, type Resolution,
} from './learn'
import { bpsDiff } from './math'
import { positionMetrics } from './position'
import { POLICY_V1, policyHash, type Policy } from './policy'

export const RECORD_SCHEMA = 'sentinel-memory/decision/v1'

export type MemoryRef = { blobId: string; kind: string; seq: number }

export type DecisionSummary = { obligationId: string; label: string; action: string; bull: number; bear: number; margin: number; healthBps: number; gapBps: number; args: { id: string; points: number; multiplierBps: number }[] }

export type MemoryEffect = { kind: 'feed_excluded' | 'argument_weight' | 'margin' | 'momentum' | 'consensus' | 'action' | 'novelty_guard'; obligationId?: string; detail: string }

export type DecisionRecord = {
	schema: typeof RECORD_SCHEMA
	seq: number
	observedAt: number
	checkpoint: string
	evidenceHash: string
	policyHash: string
	priorStateHash: string
	nextStateHash: string
	recalled: MemoryRef[] // the Walrus blobs this decision was conditioned on
	consensus: Consensus
	coldConsensus: Consensus
	decisions: DecisionSummary[]
	coldDecisions: DecisionSummary[] // the same evidence decided with EMPTY memory (the A/B)
	effects: MemoryEffect[]
	resolutions: Resolution[]
	alertResolutions: AlertResolution[]
	reasoningHash: string
}

export type RunResult = { record: DecisionRecord; decisions: PositionDecision[]; coldDecisions: PositionDecision[]; next: MemoryState; muteChanges: { source: string; muted: boolean; trustBps: number }[] }

const summarize = (d: PositionDecision): DecisionSummary => ({
	obligationId: d.obligationId,
	label: d.label,
	action: d.actionName,
	bull: d.bull.score,
	bear: d.bear.score,
	margin: d.marginPoints,
	healthBps: d.metrics.healthBps,
	gapBps: d.metrics.gapBps,
	args: [...d.bull.arguments, ...d.bear.arguments].map((a) => ({ id: a.id, points: a.points, multiplierBps: a.multiplierBps })),
})

type Learned = (obligationId: string, m: ReturnType<typeof positionMetrics>) => { multipliers: Record<string, number>; margin: number }

function decideAll(e: Evidence, p: Policy, cons: Consensus, learned: Learned, momentumBps: number | null): PositionDecision[] {
	const oracle = e.quotes.find((q) => q.source === 'suilend_oracle')
	const oracleSui = oracle?.ok ? oracle.priceMicros : 0
	const priceForMath = cons.priceMicros || oracleSui
	return e.positions.map((pos) => {
		const m = positionMetrics(pos, p, priceForMath, oracleSui)
		const l = learned(pos.obligationId, m)
		return judgePosition(
			{
				m,
				cons,
				oracleSuiMicros: oracleSui,
				oracleFresh: !!oracle && isFresh(oracle, e.observedAt, p),
				snapshotLagSec: e.observedAt - e.checkpointTs,
				momentumBps,
				multipliers: l.multipliers,
				marginPoints: l.margin,
			},
			p,
		)
	})
}

export function runStep(prior: MemoryState, e: Evidence, recalled: MemoryRef[] = [], p: Policy = POLICY_V1): RunResult {
	const cold = emptyState(p)
	// 1. consensus from the feeds memory still trusts (and, for the A/B, from all feeds)
	const cons = consensus(e, prior.sources, p)
	const coldCons = consensus(e, cold.sources, p)
	const valid = cons.used.length >= p.dataQuality.minTrustedSources

	// 2. check matured forecasts and alerts against what the chain shows now
	const oracle = e.quotes.find((q) => q.source === 'suilend_oracle')
	const oracleSui = oracle?.ok ? oracle.priceMicros : 0
	const obs: Observation = { at: e.observedAt, priceMicros: valid ? cons.priceMicros : 0, gapBps: {}, healthBps: {} }
	if (valid)
		for (const pos of e.positions) {
			const pm = positionMetrics(pos, p, cons.priceMicros, oracleSui)
			obs.gapBps[pos.obligationId] = pm.gapBps
			obs.healthBps[pos.obligationId] = pm.healthBps
		}
	const fr = resolvePending(prior, obs, forecastOf, p)
	// only alerts and misses carry regret; a quiet HOLD that stayed quiet is not news
	const regret = [...prior.regret, ...fr.alerts.map((r) => r.outcome).filter((o) => o !== 'ok')].slice(-p.memory.regretWindow)
	const margin = marginFrom(regret, p)
	const multipliers = Object.fromEntries(Object.entries(fr.voices).map(([k, v]) => [k, v.multiplierBps]))
	const momentumBps = valid && prior.lastConsensusMicros > 0 && e.observedAt - prior.lastConsensusAt <= 3 * p.memory.horizonSec ? bpsDiff(cons.priceMicros, prior.lastConsensusMicros) : null

	// 3. decide with memory, and again with empty memory on the same evidence
	// Novelty guard: memory may make the agent calmer about the FAMILIAR, never about the NEW. If risk on a loan
	// jumped by >= missMoveBps since the reading memory holds for it, learned dampening is suspended for that loan.
	const guarded: { obligationId: string; rise: number }[] = []
	const learned: Learned = (id, m) => {
		const last = prior.lastRisk?.[id]
		const rise = last ? riskRise({ gapBps: last.gapBps, healthBps: last.healthBps, priceMicros: 0 }, { gapBps: m.gapBps, healthBps: m.healthBps, priceMicros: 0 }) : 0
		if (valid && rise >= p.memory.missMoveBps) {
			guarded.push({ obligationId: id, rise })
			return { multipliers: Object.fromEntries(Object.entries(multipliers).map(([k, v]) => [k, k.startsWith('R') ? Math.max(v, 10000) : Math.min(v, 10000)])), margin: Math.min(margin, p.judge.watchMarginPoints) }
		}
		return { multipliers, margin }
	}
	const decisions = decideAll(e, p, cons, learned, momentumBps)
	const coldDecisions = decideAll(e, p, coldCons, () => ({ multipliers: {}, margin: p.judge.watchMarginPoints }), null)

	// 4. this run's claims, to be checked one horizon from now
	const items: Pending['items'] = decisions
		.filter((d) => d.action !== Action.ABSTAIN)
		.map((d) => ({ obligationId: d.obligationId, gapBps: d.metrics.gapBps, healthBps: d.metrics.healthBps, action: d.actionName as AlertKind, args: [...d.bull.arguments, ...d.bear.arguments].map((a) => a.id) }))
	const newPending: Pending[] = items.length && valid ? [{ seq: prior.seq + 1, madeAt: e.observedAt, dueAt: e.observedAt + p.memory.horizonSec, priceMicros: cons.priceMicros, items }] : []

	// 5. grade every feed (trust-blind reference) and update reliability
	const grades = gradeFeeds(e, p)
	const sources = updateFeeds(prior.sources, grades.grades, p)
	const muteChanges = Object.entries(sources)
		.filter(([s, t]) => !!t && (prior.sources[s as keyof typeof prior.sources]?.muted ?? false) !== t.muted)
		.map(([s, t]) => ({ source: s, muted: t!.muted, trustBps: t!.trustBps }))

	const next: MemoryState = {
		schema: prior.schema,
		seq: prior.seq + 1,
		updatedAt: e.observedAt,
		prevStateHash: stateHash(prior),
		sources,
		voices: fr.voices,
		pending: [...fr.pending, ...newPending].slice(-p.memory.maxPendingRuns),
		regret,
		marginPoints: margin,
		lastConsensusMicros: valid ? cons.priceMicros : prior.lastConsensusMicros,
		lastConsensusAt: valid ? e.observedAt : prior.lastConsensusAt,
		lastRisk: valid ? Object.fromEntries(decisions.map((d) => [d.obligationId, { gapBps: d.metrics.gapBps, healthBps: d.metrics.healthBps, at: e.observedAt }])) : prior.lastRisk,
	}

	// 6. what memory changed, in plain words (the A/B)
	const effects: MemoryEffect[] = []
	for (const x of cons.excluded) if (x.reason.startsWith('muted')) effects.push({ kind: 'feed_excluded', detail: `${x.source} ${x.reason}` })
	if (cons.priceMicros !== coldCons.priceMicros) effects.push({ kind: 'consensus', detail: `consensus ${cons.priceMicros} vs ${coldCons.priceMicros} micros with empty memory` })
	if (margin !== p.judge.watchMarginPoints) effects.push({ kind: 'margin', detail: `alert margin ${margin} (base ${p.judge.watchMarginPoints}) from ${regret.length} remembered alert outcomes` })
	for (const g of guarded) effects.push({ kind: 'novelty_guard', obligationId: g.obligationId, detail: `risk jumped ${g.rise} bps since the remembered reading: learned dampening suspended for this loan` })
	if (momentumBps !== null) effects.push({ kind: 'momentum', detail: `momentum ${momentumBps} bps vs remembered price ${prior.lastConsensusMicros}` })
	decisions.forEach((d, i) => {
		for (const a of [...d.bull.arguments, ...d.bear.arguments]) if (a.multiplierBps !== 10000) effects.push({ kind: 'argument_weight', obligationId: d.obligationId, detail: `${a.id} x${(a.multiplierBps / 10000).toFixed(2)} (${a.basePoints} -> ${a.points} pts)` })
		const c = coldDecisions[i]
		if (c.action !== d.action) effects.push({ kind: 'action', obligationId: d.obligationId, detail: `${d.actionName} with memory vs ${c.actionName} with empty memory` })
	})

	const eHash = evidenceHash(e)
	const pHash = policyHash(p)
	const priorStateHash = stateHash(prior)
	const nextStateHash = stateHash(next)
	const body: Omit<DecisionRecord, 'reasoningHash'> = {
		schema: RECORD_SCHEMA,
		seq: next.seq,
		observedAt: e.observedAt,
		checkpoint: e.checkpoint,
		evidenceHash: eHash,
		policyHash: pHash,
		priorStateHash,
		nextStateHash,
		recalled,
		consensus: cons,
		coldConsensus: coldCons,
		decisions: decisions.map(summarize),
		coldDecisions: coldDecisions.map(summarize),
		effects,
		resolutions: fr.resolved,
		alertResolutions: fr.alerts,
	}
	const reasoningHash = hashCanonical({ body, trails: decisions.map((d) => d.trail) })
	return { record: { ...body, reasoningHash }, decisions, coldDecisions, next, muteChanges }
}
