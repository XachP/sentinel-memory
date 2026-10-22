// Position math for one Suilend obligation. It mirrors Suilend's liquidation test: an obligation is liquidatable
// when its weighted borrow value exceeds the close-LTV value of its deposits ("unhealthy borrow value").
// SUI-linked legs are re-priced at the learned consensus price, so the agent sees what liquidators are about to see.
import type { Leg, Position } from './evidence'
import type { Policy } from './policy'

export type PositionMetrics = {
	obligationId: string
	label: string
	depositUsdMicros: number
	borrowUsdMicros: number
	unhealthyUsdMicros: number // sum(deposit * closeLtv) at consensus
	weightedBorrowUsdMicros: number // sum(borrow * borrowWeight) at consensus
	healthBps: number // unhealthy / weightedBorrow, 10000 = 1.00x = liquidation line (capped 99999)
	healthOracleBps: number // same, but at the protocol's own (possibly lagging) oracle prices
	gapBps: number // market-wide drop in volatile assets that reaches liquidation (0..10000)
	suiLinkedShareBps: number // share of deposit value that moves with SUI
	maxUtilizationBps: number
	hasBorrows: boolean
}

const CAP = 99999

function legUsd(l: Leg, priceMicros: number): number {
	return Number((BigInt(l.amountRaw) * BigInt(priceMicros)) / 10n ** BigInt(l.decimals))
}

export function positionMetrics(pos: Position, p: Policy, consensusMicros: number, oracleSuiMicros: number): PositionMetrics {
	const suiLinked = new Set<string>(p.assets.suiLinked)
	const stable = new Set<string>(p.assets.stable)
	const price = (l: Leg, useConsensus: boolean) =>
		useConsensus && suiLinked.has(l.coinType) && oracleSuiMicros > 0 && consensusMicros > 0
			? Math.round((l.oraclePriceMicros * consensusMicros) / oracleSuiMicros)
			: l.oraclePriceMicros
	const agg = (useConsensus: boolean) => {
		let dep = 0, bor = 0, U = 0, W = 0, Uvol = 0, Wvol = 0, sui = 0
		for (const l of pos.deposits) {
			const v = legUsd(l, price(l, useConsensus))
			const u = Number((BigInt(v) * BigInt(l.weightBps)) / 10000n)
			dep += v
			U += u
			if (!stable.has(l.coinType)) Uvol += u
			if (suiLinked.has(l.coinType)) sui += v
		}
		for (const l of pos.borrows) {
			const v = legUsd(l, price(l, useConsensus))
			const w = Number((BigInt(v) * BigInt(l.weightBps)) / 10000n)
			bor += v
			W += w
			if (!stable.has(l.coinType)) Wvol += w
		}
		return { dep, bor, U, W, Uvol, Wvol, sui }
	}
	const c = agg(true)
	const o = agg(false)
	const ratio = (a: number, b: number) => Number((BigInt(a) * 10000n) / BigInt(b))
	const health = (U: number, W: number) => (W === 0 ? CAP : Math.min(CAP, ratio(U, W)))
	let gap: number
	if (c.W === 0 || c.U <= c.W) gap = c.W === 0 ? 10000 : 0
	else if (c.Uvol <= c.Wvol) gap = 10000 // a uniform drop cannot liquidate it
	else gap = Math.min(10000, ratio(c.U - c.W, c.Uvol - c.Wvol))
	return {
		obligationId: pos.obligationId,
		label: pos.label,
		depositUsdMicros: c.dep,
		borrowUsdMicros: c.bor,
		unhealthyUsdMicros: c.U,
		weightedBorrowUsdMicros: c.W,
		healthBps: health(c.U, c.W),
		healthOracleBps: health(o.U, o.W),
		gapBps: gap,
		suiLinkedShareBps: c.dep === 0 ? 0 : ratio(c.sui, c.dep),
		maxUtilizationBps: pos.borrows.reduce((m, l) => Math.max(m, l.utilizationBps), 0),
		hasBorrows: pos.borrows.length > 0,
	}
}
