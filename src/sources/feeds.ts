// SUI/USD price feeds. Two are on-chain and read through Tatum Sui RPC: Suilend's reserve oracle (Pyth-fed) and a
// Cetus USDC/SUI pool. One is Tatum's Data API, which needs TATUM_API_KEY. The rest are public exchange or
// aggregator tickers. Every feed answers with a Quote, including when it fails: a failure is evidence about the feed.
import type { Quote } from '../core/evidence'
import type { SourceId } from '../core/policy'
import type { Reserve } from './suilend'

export const CETUS_USDC_SUI_POOL = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105' // USDC(6)/SUI(9), 0.25%
const SUI_TYPE = '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'

const fail = (source: SourceId, kind: Quote['kind'], now: number, err: unknown): Quote => ({ source, kind, ok: false, priceMicros: 0, ts: now, detail: String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160) })
const micros = (x: number) => Math.round(x * 1e6)

export function suilendOracleQuote(reserves: Reserve[], now: number): Quote {
	const r = reserves.find((x) => x.coinType === SUI_TYPE)
	if (!r) return fail('suilend_oracle', 'onchain', now, 'SUI reserve not found')
	return { source: 'suilend_oracle', kind: 'onchain', ok: true, priceMicros: r.priceMicros, ts: r.priceTs, detail: `suilend reserve[${r.index}].price via Tatum RPC` }
}

/** Cetus CLMM: price(B per A) = (sqrt_price / 2^64)^2 * 10^(decA - decB); pool is <USDC, SUI>, so SUI/USD = 1 / that. */
export function cetusQuote(poolFields: any | undefined, now: number): Quote {
	try {
		if (!poolFields) throw new Error('pool object missing')
		const sqrt = BigInt(poolFields.current_sqrt_price)
		// SUI per USDC (raw) = sqrt^2 / 2^128 ; SUI/USD = 2^128 / sqrt^2 * 10^(9-6) in human units
		const priceMicros = Number(((1n << 128n) * 10n ** 3n * 1_000_000n) / (sqrt * sqrt))
		if (poolFields.is_pause) throw new Error('pool paused')
		return { source: 'cetus_usdc_sui', kind: 'onchain', ok: true, priceMicros, ts: now, detail: `cetus pool ${CETUS_USDC_SUI_POOL.slice(0, 10)}… sqrt_price via Tatum RPC` }
	} catch (e) {
		return fail('cetus_usdc_sui', 'onchain', now, e)
	}
}

type Fetch = typeof fetch
async function getJson(f: Fetch, url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<any> {
	const ctl = new AbortController()
	const t = setTimeout(() => ctl.abort(), timeoutMs)
	try {
		const r = await f(url, { headers: { accept: 'application/json', 'user-agent': 'sentinel-memory/0.1', ...headers }, signal: ctl.signal })
		const text = await r.text()
		if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`)
		return JSON.parse(text)
	} finally {
		clearTimeout(t)
	}
}

export type OffchainFeed = { source: SourceId; kind: Quote['kind']; needsKey?: boolean; fetch: (f: Fetch, now: number, key: string) => Promise<Quote> }

export const OFFCHAIN_FEEDS: OffchainFeed[] = [
	{
		source: 'tatum_rate', kind: 'aggregator', needsKey: true,
		fetch: async (f, now, key) => {
			if (!key) throw new Error('TATUM_API_KEY not set')
			const j = await getJson(f, 'https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD', { 'x-api-key': key })
			return { source: 'tatum_rate', kind: 'aggregator', ok: true, priceMicros: micros(Number(j.value)), ts: Math.floor(Number(j.timestamp) / 1000) || now, detail: `tatum data api (${j.source ?? 'n/a'})` }
		},
	},
	{
		source: 'coinbase', kind: 'cex',
		fetch: async (f, now) => {
			const j = await getJson(f, 'https://api.coinbase.com/v2/prices/SUI-USD/spot')
			return { source: 'coinbase', kind: 'cex', ok: true, priceMicros: micros(Number(j.data.amount)), ts: now, detail: 'coinbase spot SUI-USD' }
		},
	},
	{
		source: 'kraken', kind: 'cex',
		fetch: async (f, now) => {
			const j = await getJson(f, 'https://api.kraken.com/0/public/Ticker?pair=SUIUSD')
			if (j.error?.length) throw new Error(j.error.join(','))
			const t = Object.values(j.result)[0] as any
			return { source: 'kraken', kind: 'cex', ok: true, priceMicros: micros(Number(t.c[0])), ts: now, detail: 'kraken last trade SUIUSD' }
		},
	},
	{
		source: 'okx', kind: 'cex',
		fetch: async (f, now) => {
			const j = await getJson(f, 'https://www.okx.com/api/v5/market/ticker?instId=SUI-USDT')
			const t = j.data?.[0]
			if (!t) throw new Error('no ticker')
			return { source: 'okx', kind: 'cex', ok: true, priceMicros: micros(Number(t.last)), ts: Math.floor(Number(t.ts) / 1000), detail: 'okx last SUI-USDT (USDT ~ USD)' }
		},
	},
	{
		source: 'coingecko', kind: 'aggregator',
		fetch: async (f) => {
			const j = await getJson(f, 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd&include_last_updated_at=true')
			return { source: 'coingecko', kind: 'aggregator', ok: true, priceMicros: micros(Number(j.sui.usd)), ts: Number(j.sui.last_updated_at), detail: 'coingecko simple price' }
		},
	},
	{
		source: 'binance', kind: 'cex',
		fetch: async (f, now) => {
			const j = await getJson(f, 'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT')
			if (!j.price) throw new Error(j.msg ?? 'no price')
			return { source: 'binance', kind: 'cex', ok: true, priceMicros: micros(Number(j.price)), ts: now, detail: 'binance SUIUSDT (USDT ~ USD)' }
		},
	},
]

export async function fetchOffchain(now: number, key = process.env.TATUM_API_KEY ?? '', f: Fetch = fetch): Promise<Quote[]> {
	// a keyed feed with no key is left out entirely, not graded as an error (that would teach a fake lesson)
	return Promise.all(OFFCHAIN_FEEDS.filter((feed) => !feed.needsKey || key).map((feed) => feed.fetch(f, now, key).catch((e) => fail(feed.source, feed.kind, now, e))))
}
