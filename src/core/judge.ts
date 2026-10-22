// The judge, adapted from Lifeline Sentinel: a fixed, ordered rule list where the first matching rule decides.
// Hard rules (data gates, escalation line) come before any score comparison and memory cannot change them.
// Memory enters only through the inputs: which feeds formed the consensus, the argument multipliers and the margin.
import { bearCase, bullCase, type AgentCase, type Context } from './agents'
import type { Consensus } from './learn'
import type { PositionMetrics } from './position'
import type { Policy } from './policy'

export enum Action { HOLD = 0, WATCH = 1, ESCALATE = 2, ABSTAIN = 3 }
export type TrailStep = { rule: string; passed: boolean; detail: string }

export type PositionDecision = {
	obligationId: string
	label: string
	action: Action
	actionName: keyof typeof Action
	confidenceBps: number
	marginPoints: number
	bull: AgentCase
	bear: AgentCase
	trail: TrailStep[]
	metrics: PositionMetrics
}

export type JudgeInput = {
	m: PositionMetrics
	cons: Consensus
	oracleSuiMicros: number
	oracleFresh: boolean
	snapshotLagSec: number
	momentumBps: number | null
	multipliers: Record<string, number>
	marginPoints: number
}

export function judgePosition(inp: JudgeInput, p: Policy): PositionDecision {
	const { m, cons } = inp
	const ctx: Context = { m, consensusMicros: cons.priceMicros, oracleSuiMicros: inp.oracleSuiMicros, usedSources: cons.used.length, momentumBps: inp.momentumBps, multipliers: inp.multipliers }
	const bull = bullCase(ctx, p)
	const bear = bearCase(ctx, p)
	const net = bear.score - bull.score
	const q = p.dataQuality
	const trail: TrailStep[] = []
	const step = (rule: string, passed: boolean, detail: string) => (trail.push({ rule, passed, detail }), passed)
	const oracleDev = cons.priceMicros > 0 && inp.oracleSuiMicros > 0 ? Math.round((Math.abs(inp.oracleSuiMicros - cons.priceMicros) * 10000) / cons.priceMicros) : 99999

	let action: Action | undefined
	let confidence = 10000
	// Rule 0: data quality. Acting on bad data is the classic breach of duty, so the agent abstains instead.
	const gates = [
		step('Q1_obligation_has_debt', m.hasBorrows, m.hasBorrows ? 'obligation has open borrows' : 'no borrows: nothing to guard'),
		step('Q2_enough_trusted_feeds', cons.used.length >= q.minTrustedSources, `${cons.used.length} trusted fresh feeds (${cons.used.join(', ')}) >= ${q.minTrustedSources}`),
		step('Q3_oracle_vs_consensus', oracleDev <= q.maxOracleVsConsensusBps, `suilend oracle vs consensus ${oracleDev} bps <= ${q.maxOracleVsConsensusBps}`),
		step('Q4_oracle_fresh', inp.oracleFresh, inp.oracleFresh ? 'suilend SUI price is fresh' : `suilend SUI price older than ${q.maxOracleAgeSec}s`),
		step('Q5_snapshot_fresh', inp.snapshotLagSec >= -60 && inp.snapshotLagSec <= q.maxSnapshotLagSec, `checkpoint lag ${inp.snapshotLagSec}s <= ${q.maxSnapshotLagSec}s`),
	]
	if (gates.some((g) => !g)) action = Action.ABSTAIN

	// Rule 1 (hard): below the escalation line the owner must act now: repay or add collateral.
	if (action === undefined && step('R1_escalation_line', m.healthBps < p.risk.escalateHealthBps, `cover ${m.healthBps} bps < ${p.risk.escalateHealthBps} bps`)) action = Action.ESCALATE

	// Rule 2 (soft): the bear must beat the bull by the learned margin to raise a WATCH.
	if (action === undefined) {
		if (step('R2_bear_margin', net >= inp.marginPoints, `bear ${bear.score} - bull ${bull.score} = ${net} >= margin ${inp.marginPoints}`)) action = Action.WATCH
		else {
			action = Action.HOLD
			step('R3_default_hold', true, 'no rule requires action')
		}
		confidence = Math.min(10000, 5000 + Math.abs(net - inp.marginPoints) * 10)
	}
	return { obligationId: m.obligationId, label: m.label, action, actionName: Action[action] as keyof typeof Action, confidenceBps: confidence, marginPoints: inp.marginPoints, bull, bear, trail, metrics: m }
}
