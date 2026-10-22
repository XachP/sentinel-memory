// Synthetic evidence for unit tests. Real mainnet evidence lives in test/fixtures; anything built here is
// labelled synthetic and never written to Walrus.
import { EVIDENCE_SCHEMA, type Evidence, type Leg, type Quote } from '../src/core/evidence'
import type { SourceId } from '../src/core/policy'

export const SUI = '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
export const USDC = 'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
export const ETH = 'd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH'

export function leg(coinType: string, usd: number, priceMicros: number, weightBps: number, decimals = 9, utilizationBps = 5000, ts = 1_000_000): Leg {
	const amount = (BigInt(Math.round(usd * 1e6)) * 10n ** BigInt(decimals)) / BigInt(priceMicros)
	return { coinType, symbol: coinType.split('::').pop()!, amountRaw: amount.toString(), decimals, oraclePriceMicros: priceMicros, oraclePriceTs: ts, weightBps, utilizationBps }
}

const KINDS: Record<SourceId, Quote['kind']> = { suilend_oracle: 'onchain', cetus_usdc_sui: 'onchain', tatum_rate: 'aggregator', coinbase: 'cex', kraken: 'cex', okx: 'cex', coingecko: 'aggregator', binance: 'cex' }

export function quotes(now: number, price: number, overrides: Partial<Record<SourceId, Partial<Quote>>> = {}, sources: SourceId[] = ['suilend_oracle', 'cetus_usdc_sui', 'coinbase', 'kraken', 'okx', 'coingecko']): Quote[] {
	return sources.map((s) => ({ source: s, kind: KINDS[s], ok: true, priceMicros: price, ts: now, detail: 'synthetic', ...overrides[s] }))
}

/** One SUI-collateral / USDC-debt loan. suiUsd = collateral value at $1.00/SUI (the token amount is fixed), usdcDebt in dollars. */
export function evidence(now: number, suiPrice: number, opts: { suiUsd?: number; usdcDebt?: number; overrides?: Partial<Record<SourceId, Partial<Quote>>>; util?: number } = {}): Evidence {
	const suiUsd = opts.suiUsd ?? 10_000
	const debt = opts.usdcDebt ?? 5_000
	return {
		schema: EVIDENCE_SCHEMA,
		observedAt: now,
		checkpoint: String(now),
		checkpointTs: now,
		lendingMarket: '0xsynthetic',
		positions: [{ obligationId: '0xaaa', label: 'synthetic SUI vs USDC', deposits: [{ ...leg(SUI, suiUsd, 1_000_000, 7500, 9, 5000, now), oraclePriceMicros: suiPrice }], borrows: [leg(USDC, debt, 1_000_000, 10000, 6, opts.util ?? 5000, now)] }],
		quotes: quotes(now, suiPrice, opts.overrides ?? {}),
	}
}
