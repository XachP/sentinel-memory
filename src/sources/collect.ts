// Build one Evidence record. One Tatum GraphQL request returns the latest checkpoint plus the Suilend market,
// the watched obligations and the Cetus pool, so a run fits Tatum's anonymous 5/min plan.
import { EVIDENCE_SCHEMA, type Evidence } from '../core/evidence'
import { cetusQuote, CETUS_USDC_SUI_POOL, fetchOffchain, suilendOracleQuote } from './feeds'
import { parseObligation, parseReserves, SUILEND_MAIN_MARKET } from './suilend'
import { TatumSui } from './tatum'

export type Watch = { obligationId: string; label: string }

export async function collect(watch: Watch[], tatum = new TatumSui(), now = Math.floor(Date.now() / 1000)): Promise<{ evidence: Evidence; raw: Record<string, unknown> }> {
	const [read, offchain] = await Promise.all([
		tatum.read([SUILEND_MAIN_MARKET, CETUS_USDC_SUI_POOL, ...watch.map((w) => w.obligationId)]),
		fetchOffchain(now),
	])
	const cp = read.checkpoint
	const objs = read.objects
	const byId = new Map(objs.filter((o) => o.data).map((o) => [o.data!.objectId, o.data!]))
	const market = byId.get(SUILEND_MAIN_MARKET)?.content?.fields
	if (!market) throw new Error('Suilend lending market not returned by Tatum')
	const reserves = parseReserves(market)
	const positions = watch.flatMap((w) => {
		const o = byId.get(w.obligationId)?.content?.fields
		return o ? [parseObligation(w.obligationId, w.label, o, reserves)] : []
	})
	const evidence: Evidence = {
		schema: EVIDENCE_SCHEMA,
		observedAt: now,
		checkpoint: cp.sequenceNumber,
		checkpointTs: Math.floor(Number(cp.timestampMs) / 1000),
		lendingMarket: SUILEND_MAIN_MARKET,
		positions,
		quotes: [suilendOracleQuote(reserves, now), cetusQuote(byId.get(CETUS_USDC_SUI_POOL)?.content?.fields, now), ...offchain],
	}
	return { evidence, raw: { checkpoint: cp, objects: objs.map((o) => ({ id: o.data?.objectId, version: o.data?.version })) } }
}
