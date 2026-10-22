// The measured A/B. Replays a sequence of real evidence records twice: once with memory chained run to run, the
// way the agent actually runs, and once with memory wiped before every run. Each decision is then scored in
// hindsight against the first observation at least one horizon later, using a trust-blind price reference
// (the median of all fresh feeds) so neither regime grades itself.
import type { Evidence } from './evidence'
import { emptyState, gradeFeeds, riskRise, type MemoryState } from './learn'
import { positionMetrics } from './position'
import { POLICY_V1, type Policy } from './policy'
import { runStep } from './step'

type Tally = { decisions: number; alerts: number; justified: number; falseAlarms: number; holds: number; missed: number; unscored: number; abstain: number }
const tally = (): Tally => ({ decisions: 0, alerts: 0, justified: 0, falseAlarms: 0, holds: 0, missed: 0, unscored: 0, abstain: 0 })

export function scorecard(evidences: Evidence[], p: Policy = POLICY_V1) {
	const ev = [...evidences].sort((a, b) => a.observedAt - b.observedAt)
	let state: MemoryState = emptyState(p)
	const rows: { seq: number; observedAt: number; withMemory: string[]; emptyMemory: string[]; consensusWith: number; consensusEmpty: number; effects: number }[] = []
	const truthAt = (e: Evidence) => {
		const ref = gradeFeeds(e, p).referenceMicros
		const oracle = e.quotes.find((q) => q.source === 'suilend_oracle')
		const o = oracle?.ok ? oracle.priceMicros : 0
		return Object.fromEntries(e.positions.map((pos) => { const m = positionMetrics(pos, p, ref || o, o); return [pos.obligationId, { gapBps: m.gapBps, healthBps: m.healthBps, priceMicros: ref }] }))
	}
	const truths = ev.map(truthAt)
	const mem = tally(), cold = tally()
	let changedAction = 0, changedConsensus = 0, changedScores = 0
	ev.forEach((e, i) => {
		const r = runStep(state, e, [], p)
		state = r.next
		const j = ev.findIndex((x) => x.observedAt >= e.observedAt + p.memory.horizonSec)
		const score = (t: Tally, action: string, oblId: string) => {
			t.decisions++
			if (action === 'ABSTAIN') return void t.abstain++
			const base = truths[i][oblId]
			const later = j >= 0 ? truths[j][oblId] : undefined
			if (action === 'HOLD') t.holds++
			else t.alerts++
			if (!base || !later) return void t.unscored++
			const rise = riskRise(base, later)
			if (action === 'HOLD') { if (rise >= p.memory.missMoveBps) t.missed++ }
			else if (rise >= p.memory.forecastMoveBps) t.justified++
			else t.falseAlarms++
		}
		r.decisions.forEach((d, k) => {
			const c = r.coldDecisions[k]
			score(mem, d.actionName, d.obligationId)
			score(cold, c.actionName, c.obligationId)
			if (d.actionName !== c.actionName) changedAction++
			if (d.bull.score !== c.bull.score || d.bear.score !== c.bear.score) changedScores++
		})
		if (r.record.consensus.priceMicros !== r.record.coldConsensus.priceMicros) changedConsensus++
		rows.push({ seq: r.next.seq, observedAt: e.observedAt, withMemory: r.decisions.map((d) => d.actionName), emptyMemory: r.coldDecisions.map((d) => d.actionName), consensusWith: r.record.consensus.priceMicros, consensusEmpty: r.record.coldConsensus.priceMicros, effects: r.record.effects.length })
	})
	const rate = (a: number, b: number) => (b ? Math.round((a * 10000) / b) : 0)
	return {
		summary: {
			runs: ev.length,
			firstAt: ev[0]?.observedAt ?? 0,
			lastAt: ev[ev.length - 1]?.observedAt ?? 0,
			runsWhereMemoryChangedConsensus: changedConsensus,
			decisionsWhereMemoryChangedScores: changedScores,
			decisionsWhereMemoryChangedAction: changedAction,
			withMemory: { ...mem, falseAlarmRateBps: rate(mem.falseAlarms, mem.justified + mem.falseAlarms), missRateBps: rate(mem.missed, mem.holds) },
			emptyMemory: { ...cold, falseAlarmRateBps: rate(cold.falseAlarms, cold.justified + cold.falseAlarms), missRateBps: rate(cold.missed, cold.holds) },
			mutedFeeds: Object.entries(state.sources).filter(([, t]) => t?.muted).map(([k]) => k),
			argumentCredibility: Object.fromEntries(Object.entries(state.voices).map(([k, v]) => [k, { credBps: v.credBps, n: v.n, multiplierBps: v.multiplierBps }])),
			finalMarginPoints: state.marginPoints,
		},
		rows,
	}
}
