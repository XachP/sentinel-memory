// Two adversarial agents argue from the SAME evidence, adapted from Lifeline Sentinel. Every argument names the
// evidence it relies on AND the forecast it implies, so memory can later check whether it was right.
// Points are scaled by the argument's learned credibility multiplier (bounded by policy). No LLM in this path.
import type { ForecastKind } from './learn'
import { pct, usd } from './math'
import type { PositionMetrics } from './position'
import type { Policy } from './policy'

export type Argument = {
	id: string
	claim: string
	basePoints: number
	multiplierBps: number
	points: number // basePoints * multiplier
	forecast: ForecastKind
	evidence: string[]
}
export type AgentCase = { agent: 'bull' | 'bear'; score: number; arguments: Argument[] }
export type Context = {
	m: PositionMetrics
	consensusMicros: number
	oracleSuiMicros: number
	usedSources: number
	momentumBps: number | null // vs the last consensus price recalled from memory (null = nothing remembered)
	multipliers: Record<string, number>
}

/** What each argument implicitly predicts. Bull arguments say the risk will not rise; bear arguments say it will. */
export const ARG_FORECAST: Record<string, ForecastKind> = {
	B1_health_headroom: 'gap_holds',
	B2_liquidation_far: 'gap_holds',
	B3_oracle_matches_market: 'gap_holds',
	B4_momentum_up: 'price_up',
	B5_liquidity_ok: 'gap_holds',
	R1_near_liquidation: 'gap_shrinks',
	R2_liquidation_close: 'gap_shrinks',
	R3_oracle_lags_market: 'gap_shrinks',
	R4_momentum_down: 'price_down',
	R5_utilization_high: 'gap_shrinks',
	R6_thin_consensus: 'gap_shrinks',
}
export const forecastOf = (argId: string): ForecastKind => ARG_FORECAST[argId] ?? (argId.startsWith('B') ? 'gap_holds' : 'gap_shrinks')

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function arg(ctx: Context, id: string, claim: string, basePoints: number, _forecast: ForecastKind, evidence: string[]): Argument {
	const multiplierBps = ctx.multipliers[id] ?? 10000
	return { id, claim, basePoints, multiplierBps, points: Math.floor((basePoints * multiplierBps) / 10000), forecast: forecastOf(id), evidence }
}
const total = (a: Argument[]) => a.reduce((s, x) => s + x.points, 0)
const x = (bps: number) => `${(bps / 10000).toFixed(2)}x`

/** Bull: the loan is safe and nothing intrusive should happen. */
export function bullCase(ctx: Context, p: Policy): AgentCase {
	const { m } = ctx
	const a: Argument[] = []
	if (m.healthBps >= p.risk.healthWatchBps)
		a.push(arg(ctx, 'B1_health_headroom', `Borrow limit cover ${x(m.healthBps)} is above the ${x(p.risk.healthWatchBps)} watch line.`, clamp(Math.floor((m.healthBps - p.risk.healthWatchBps) / 5), 0, 300), 'gap_holds', ['positions.deposits', 'positions.borrows', 'consensus']))
	if (m.gapBps >= p.risk.gapWatchBps)
		a.push(arg(ctx, 'B2_liquidation_far', `Volatile collateral would have to fall ${pct(m.gapBps)} before liquidation.`, 150, 'gap_holds', ['positions.deposits', 'positions.borrows']))
	if (ctx.oracleSuiMicros > 0 && Math.abs(ctx.oracleSuiMicros - ctx.consensusMicros) * 10000 <= p.dataQuality.agreeBps * ctx.consensusMicros)
		a.push(arg(ctx, 'B3_oracle_matches_market', `Suilend's oracle ${usd(ctx.oracleSuiMicros)} matches the ${ctx.usedSources}-feed consensus ${usd(ctx.consensusMicros)}.`, 50, 'gap_holds', ['quotes.suilend_oracle', 'consensus']))
	if (ctx.momentumBps !== null && ctx.momentumBps >= p.risk.momentumBps)
		a.push(arg(ctx, 'B4_momentum_up', `SUI is up ${pct(ctx.momentumBps)} since the last price the agent remembers.`, 80, 'price_up', ['consensus', 'memory.lastConsensusMicros']))
	if (m.hasBorrows && m.maxUtilizationBps < p.risk.utilizationWatchBps)
		a.push(arg(ctx, 'B5_liquidity_ok', `Borrowed reserves are ${pct(m.maxUtilizationBps)} utilized, so repaying stays cheap.`, 50, 'gap_holds', ['positions.borrows.utilizationBps']))
	return { agent: 'bull', score: total(a), arguments: a }
}

/** Bear: the loan is at risk and the owner should be told. */
export function bearCase(ctx: Context, p: Policy): AgentCase {
	const { m } = ctx
	const a: Argument[] = []
	if (m.healthBps < p.risk.healthWatchBps)
		a.push(arg(ctx, 'R1_near_liquidation', `Borrow limit cover is only ${x(m.healthBps)}, below the ${x(p.risk.healthWatchBps)} watch line.`, clamp(Math.floor((p.risk.healthWatchBps - m.healthBps) / 5), 0, 300), 'gap_shrinks', ['positions.deposits', 'positions.borrows', 'consensus']))
	if (m.gapBps < p.risk.gapWatchBps)
		a.push(arg(ctx, 'R2_liquidation_close', `A ${pct(m.gapBps)} market-wide drop would liquidate this loan.`, 200, 'gap_shrinks', ['positions.deposits', 'positions.borrows']))
	if (ctx.oracleSuiMicros > 0 && (ctx.oracleSuiMicros - ctx.consensusMicros) * 10000 > p.dataQuality.agreeBps * ctx.consensusMicros)
		a.push(arg(ctx, 'R3_oracle_lags_market', `Suilend's oracle ${usd(ctx.oracleSuiMicros)} is ABOVE the market ${usd(ctx.consensusMicros)}: real cover is worse than the protocol shows (${x(m.healthOracleBps)} vs ${x(m.healthBps)}).`, 100, 'gap_shrinks', ['quotes.suilend_oracle', 'consensus']))
	if (ctx.momentumBps !== null && ctx.momentumBps <= -p.risk.momentumBps)
		a.push(arg(ctx, 'R4_momentum_down', `SUI is down ${pct(-ctx.momentumBps)} since the last price the agent remembers.`, 80, 'price_down', ['consensus', 'memory.lastConsensusMicros']))
	if (m.hasBorrows && m.maxUtilizationBps >= p.risk.utilizationWatchBps)
		a.push(arg(ctx, 'R5_utilization_high', `A borrowed reserve is ${pct(m.maxUtilizationBps)} utilized: borrow rates spike and exits get crowded.`, 60, 'gap_shrinks', ['positions.borrows.utilizationBps']))
	if (ctx.usedSources === p.dataQuality.minTrustedSources)
		a.push(arg(ctx, 'R6_thin_consensus', `Only ${ctx.usedSources} trusted feeds are left, the bare minimum.`, 40, 'gap_shrinks', ['consensus.used']))
	return { agent: 'bear', score: total(a), arguments: a }
}
