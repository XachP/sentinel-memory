// The evidence record holds everything the agent is allowed to look at, and nothing else. It is built from Tatum
// Sui RPC reads (Suilend market and obligations, Cetus pool, checkpoint) and the price feeds. Integers only, so it
// hashes the same everywhere.
import { hashCanonical } from './canonical'
import type { SourceId } from './policy'

export const EVIDENCE_SCHEMA = 'sentinel-memory/evidence/v1'

export type Quote = {
	source: SourceId
	kind: 'onchain' | 'cex' | 'aggregator'
	ok: boolean
	priceMicros: number // SUI/USD, 1e6 = $1.00 (0 when !ok)
	ts: number // unix seconds the feed says the price is from (observedAt when the feed gives none)
	detail: string // short provenance: endpoint / object id, or the error
}

export type Leg = {
	coinType: string
	symbol: string
	amountRaw: string // token base units (bigint as string)
	decimals: number
	oraclePriceMicros: number // Suilend reserve price, USD per whole token, 1e6 = $1
	oraclePriceTs: number
	weightBps: number // deposits: close LTV; borrows: borrow weight
	utilizationBps: number // reserve utilization of this asset
}

export type Position = {
	obligationId: string
	label: string
	deposits: Leg[]
	borrows: Leg[]
}

export type Evidence = {
	schema: typeof EVIDENCE_SCHEMA
	observedAt: number
	checkpoint: string
	checkpointTs: number
	lendingMarket: string
	positions: Position[]
	quotes: Quote[]
}

export const evidenceHash = (e: Evidence) => hashCanonical(e)
