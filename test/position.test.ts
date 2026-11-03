import { describe, expect, test } from 'bun:test'
import lm from './fixtures/rpc-lending-market.json'
import obl from './fixtures/rpc-obligation-0x2c42.json'
import gqlMarket from './fixtures/gql-lending-market.json'
import gqlObl from './fixtures/gql-obligation-0x2c42.json'
import gqlCetus from './fixtures/gql-cetus-pool.json'
import { positionMetrics } from '../src/core/position'
import { POLICY_V1 as P } from '../src/core/policy'
import { parseObligation, parseReserves, storedValues } from '../src/sources/suilend'
import { cetusQuote, suilendOracleQuote } from '../src/sources/feeds'
import { evidence, leg, SUI, USDC } from './helpers'

/** JSON-RPC `{type, fields}` → the flat object Tatum GraphQL returns. TypeName becomes the type string. */
function flattenRpcMove(x: any): any {
	if (Array.isArray(x)) return x.map(flattenRpcMove)
	if (x && typeof x === 'object') {
		if (typeof x.type === 'string' && x.fields && typeof x.fields === 'object') {
			if (String(x.type).includes('::type_name::TypeName')) return x.fields.name
			const out: any = {}
			for (const [k, v] of Object.entries(x.fields)) out[k] = flattenRpcMove(v)
			return out
		}
		const out: any = {}
		for (const [k, v] of Object.entries(x)) out[k] = flattenRpcMove(v)
		return out
	}
	return x
}

function depositMarketMicros(d: any): number {
	const mv = d?.fields?.market_value ?? d?.market_value
	const v = mv?.fields?.value ?? mv?.value ?? mv ?? 0
	return Number(BigInt(v) / 10n ** 12n)
}

describe('position math', () => {
	test('cover and drop-to-liquidation for a plain SUI/USDC loan', () => {
		const e = evidence(1000, 1_000_000) // $10k SUI at 75% close LTV, $5k USDC debt
		const m = positionMetrics(e.positions[0], P, 1_000_000, 1_000_000)
		expect(m.unhealthyUsdMicros).toBe(7_500_000_000)
		expect(m.weightedBorrowUsdMicros).toBe(5_000_000_000)
		expect(m.healthBps).toBe(15000) // 1.50x
		expect(m.gapBps).toBe(3333) // (7500-5000)/7500
	})
	test('SUI-linked legs are re-priced at the consensus, so a lagging oracle cannot hide a drop', () => {
		const e = evidence(1000, 1_000_000)
		const atOracle = positionMetrics(e.positions[0], P, 1_000_000, 1_000_000)
		const marketDown = positionMetrics(e.positions[0], P, 900_000, 1_000_000)
		expect(marketDown.healthBps).toBe(13500)
		expect(marketDown.healthOracleBps).toBe(atOracle.healthBps)
	})
	test('a SUI-vs-SUI loop cannot be liquidated by a market-wide drop (gap capped at 100%)', () => {
		const pos = { obligationId: '0x1', label: 'loop', deposits: [leg(SUI, 1000, 1_000_000, 7500)], borrows: [leg(SUI, 700, 1_000_000, 10000)] }
		const m = positionMetrics(pos, P, 1_000_000, 1_000_000)
		expect(m.healthBps).toBe(10714)
		expect(m.gapBps).toBe(10000)
	})
	test('underwater loans have zero gap', () => {
		const pos = { obligationId: '0x1', label: 'x', deposits: [leg(SUI, 1000, 1_000_000, 7500)], borrows: [leg(USDC, 800, 1_000_000, 10000, 6)] }
		expect(positionMetrics(pos, P, 1_000_000, 1_000_000).gapBps).toBe(0)
	})
})

describe('Suilend parsing (real mainnet RPC responses via Tatum)', () => {
	const reserves = parseReserves((lm as any).result.data.content.fields)
	const f = (obl as any).result.data.content.fields
	test('reserves parse with prices, LTVs and utilization', () => {
		expect(reserves.length).toBe(45)
		const sui = reserves.find((r) => r.coinType.endsWith('::sui::SUI'))!
		expect(sui.closeLtvPct).toBe(75)
		expect(sui.priceMicros).toBe(984117)
		expect(sui.utilizationBps).toBeGreaterThan(0)
		expect(suilendOracleQuote(reserves, sui.priceTs + 10).priceMicros).toBe(984117)
	})
	test('re-derived obligation values agree with what Suilend stored at its last refresh', () => {
		const pos = parseObligation('0x2c42', 'fixture', f, reserves)
		expect(pos.deposits.map((d) => d.symbol)).toEqual(['SUI', 'DEEP', 'SPRING_SUI', 'ETH', 'SEND'])
		expect(pos.borrows.map((d) => d.symbol)).toEqual(['USDC'])
		const sui = reserves.find((r) => r.coinType.endsWith('::sui::SUI'))!.priceMicros
		const m = positionMetrics(pos, P, sui, sui)
		const s = storedValues(f)
		// the USDC debt (accrued with the reserve's cumulative borrow rate) matches to 0.5%
		expect(Math.abs(m.weightedBorrowUsdMicros - s.weightedBorrowUsdMicros) / s.weightedBorrowUsdMicros).toBeLessThan(0.005)
		// our close-LTV weights applied to Suilend's own stored leg values reproduce its unhealthy borrow value
		const fromStored = (f.deposits as any[]).reduce((sum, d, i) => sum + (depositMarketMicros(d) * pos.deposits[i].weightBps) / 10000, 0)
		expect(Math.abs(fromStored - s.unhealthyUsdMicros) / s.unhealthyUsdMicros).toBeLessThan(0.001)
		// prices moved between the refresh and our read, so totals only roughly agree
		expect(Math.abs(m.depositUsdMicros - s.depositUsdMicros) / s.depositUsdMicros).toBeLessThan(0.06)
	})
	test('flat GraphQL json parses to the same reserves and obligation as the Oct 22 RPC fixture', () => {
		const flatMarket = flattenRpcMove((lm as any).result.data.content.fields)
		const flatObl = flattenRpcMove(f)
		const flatReserves = parseReserves(flatMarket)
		expect(flatReserves).toEqual(reserves)
		const pos = parseObligation('0x2c42', 'fixture', f, reserves)
		expect(parseObligation('0x2c42', 'fixture', flatObl, flatReserves)).toEqual(pos)
		expect(storedValues(flatObl)).toEqual(storedValues(f))
		// the flattened coin type is the bare string GraphQL returns, not {fields:{name}}
		expect(typeof flatMarket.reserves[0].coin_type).toBe('string')
		expect(flatMarket.reserves[0].config.fields).toBeUndefined()
		expect(flatObl.deposits[0].fields).toBeUndefined()
	})
})

describe('Suilend parsing (Tatum GraphQL, captured Nov 3, 2026)', () => {
	const reserves = parseReserves(gqlMarket)
	test('the flat market still has 45 reserves and the same SUI close LTV', () => {
		expect(reserves.length).toBe(45)
		const sui = reserves.find((r) => r.coinType.endsWith('::sui::SUI'))!
		expect(sui.index).toBe(0)
		expect(sui.closeLtvPct).toBe(75)
		expect(sui.borrowWeightBps).toBe(10000)
		expect(sui.priceMicros).toBe(900546)
		expect(sui.utilizationBps).toBeGreaterThan(0)
		expect(suilendOracleQuote(reserves, sui.priceTs + 10).priceMicros).toBe(900546)
	})
	test('re-derived obligation values still agree with what Suilend stored', () => {
		const pos = parseObligation('0x2c42', 'fixture', gqlObl, reserves)
		expect(pos.deposits.map((d) => d.symbol)).toEqual(['SUI', 'DEEP', 'SPRING_SUI', 'ETH', 'SEND'])
		expect(pos.borrows.map((d) => d.symbol)).toEqual(['USDC'])
		const sui = reserves.find((r) => r.coinType.endsWith('::sui::SUI'))!.priceMicros
		const m = positionMetrics(pos, P, sui, sui)
		const s = storedValues(gqlObl)
		expect(Math.abs(m.weightedBorrowUsdMicros - s.weightedBorrowUsdMicros) / s.weightedBorrowUsdMicros).toBeLessThan(0.005)
		const fromStored = (gqlObl.deposits as any[]).reduce((sum, d, i) => sum + (depositMarketMicros(d) * pos.deposits[i].weightBps) / 10000, 0)
		expect(Math.abs(fromStored - s.unhealthyUsdMicros) / s.unhealthyUsdMicros).toBeLessThan(0.001)
		expect(Math.abs(m.depositUsdMicros - s.depositUsdMicros) / s.depositUsdMicros).toBeLessThan(0.06)
	})
	test('Cetus sqrt_price from the flat pool object', () => {
		const q = cetusQuote(gqlCetus, 0)
		expect(q.ok).toBe(true)
		expect(q.priceMicros).toBe(900228)
		expect(cetusQuote({ ...gqlCetus, is_pause: true }, 0).ok).toBe(false)
	})
})
