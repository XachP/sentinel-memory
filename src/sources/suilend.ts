// Suilend (main pool) on Sui mainnet, read through Tatum. The obligation's stored USD values are as of its last
// refresh, so the agent re-derives everything from the reserve state: cToken exchange rates, cumulative borrow
// rates and reserve prices.
import type { Leg, Position } from '../core/evidence'

export const SUILEND_MAIN_MARKET = '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1'
const WAD = 10n ** 18n

const dec = (x: any): bigint => BigInt(x?.fields?.value ?? x?.value ?? x ?? 0)
const coin = (x: any): string => x?.fields?.name ?? x?.name
const symbolOf = (t: string) => t.split('::').pop() ?? t

export type Reserve = {
	index: number
	coinType: string
	decimals: number
	priceMicros: number
	priceTs: number
	totalSupplyRaw: bigint // available + borrowed - unclaimed spread fees (token units)
	ctokenSupply: bigint
	cumulativeBorrowRate: bigint // WAD
	closeLtvPct: number
	borrowWeightBps: number
	utilizationBps: number
}

export function parseReserves(marketFields: any): Reserve[] {
	return (marketFields.reserves as any[]).map((r, i) => {
		const f = r.fields
		const cfg = f.config.fields.element.fields
		const available = BigInt(f.available_amount)
		const borrowed = dec(f.borrowed_amount) / WAD
		const unclaimed = dec(f.unclaimed_spread_fees) / WAD
		const total = available + borrowed - unclaimed
		return {
			index: Number(f.array_index ?? i),
			coinType: coin(f.coin_type),
			decimals: Number(f.mint_decimals),
			priceMicros: Number(dec(f.price) / 10n ** 12n),
			priceTs: Number(f.price_last_update_timestamp_s),
			totalSupplyRaw: total,
			ctokenSupply: BigInt(f.ctoken_supply),
			cumulativeBorrowRate: dec(f.cumulative_borrow_rate),
			closeLtvPct: Number(cfg.close_ltv_pct),
			borrowWeightBps: Number(cfg.borrow_weight_bps),
			utilizationBps: total > 0n ? Number((borrowed * 10000n) / total) : 0,
		}
	})
}

export function parseObligation(obligationId: string, label: string, f: any, reserves: Reserve[]): Position {
	const byIndex = new Map(reserves.map((r) => [r.index, r]))
	const deposits: Leg[] = (f.deposits as any[]).map((d) => {
		const x = d.fields
		const r = byIndex.get(Number(x.reserve_array_index))!
		const ctokens = BigInt(x.deposited_ctoken_amount)
		const amount = r.ctokenSupply > 0n ? (ctokens * r.totalSupplyRaw) / r.ctokenSupply : 0n
		return { coinType: r.coinType, symbol: symbolOf(r.coinType), amountRaw: amount.toString(), decimals: r.decimals, oraclePriceMicros: r.priceMicros, oraclePriceTs: r.priceTs, weightBps: r.closeLtvPct * 100, utilizationBps: r.utilizationBps }
	})
	const borrows: Leg[] = (f.borrows as any[]).map((b) => {
		const x = b.fields
		const r = byIndex.get(Number(x.reserve_array_index))!
		const owedWad = dec(x.borrowed_amount)
		const userRate = dec(x.cumulative_borrow_rate)
		const amount = userRate > 0n ? (owedWad * r.cumulativeBorrowRate) / userRate / WAD : 0n
		return { coinType: r.coinType, symbol: symbolOf(r.coinType), amountRaw: amount.toString(), decimals: r.decimals, oraclePriceMicros: r.priceMicros, oraclePriceTs: r.priceTs, weightBps: r.borrowWeightBps, utilizationBps: r.utilizationBps }
	})
	return { obligationId, label, deposits, borrows }
}

/** Stored values from the obligation's last refresh. Used only to sanity-check our re-derivation in tests. */
export function storedValues(f: any) {
	return { unhealthyUsdMicros: Number(dec(f.unhealthy_borrow_value_usd) / 10n ** 12n), weightedBorrowUsdMicros: Number(dec(f.weighted_borrowed_value_usd) / 10n ** 12n), depositUsdMicros: Number(dec(f.deposited_value_usd) / 10n ** 12n) }
}
