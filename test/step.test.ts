import { describe, expect, test } from 'bun:test'
import run1 from './fixtures/run-mainnet-00001.json'
import { emptyState, stateHash, type MemoryState } from '../src/core/learn'
import { POLICY_V1 as P } from '../src/core/policy'
import { runStep } from '../src/core/step'
import { evidence } from './helpers'

const H = P.memory.horizonSec + 600 // one run per horizon (plus slack) so every run's claims mature by the next

/** Run a sequence of synthetic evidence through the agent with memory chained run to run. */
function chain(es: ReturnType<typeof evidence>[], start: MemoryState = emptyState(P)) {
	let s = start
	return es.map((e) => {
		const r = runStep(s, e, [], P)
		s = r.next
		return r
	})
}

describe('memory visibly changes later decisions', () => {
	// $10k of SUI at 75% close LTV against $6.1k USDC: cover 1.23x, a 19% drop liquidates it
	const tight = (i: number, price = 1_000_000) => evidence(1_000_000 + i * H, price, { usdcDebt: 6_100 })

	test('day 1: memory and empty memory agree (nothing learned yet)', () => {
		const [r] = chain([tight(0)])
		expect(r.decisions[0].actionName).toBe('WATCH')
		expect(r.coldDecisions[0].actionName).toBe('WATCH')
		expect(r.record.effects.filter((e) => e.kind === 'action')).toEqual([])
	})

	test('after a week of WATCH alerts that never mattered, the agent stops crying wolf, and the record says why', () => {
		const rs = chain(Array.from({ length: 30 }, (_, i) => tight(i)))
		const last = rs[rs.length - 1]
		expect(last.coldDecisions[0].actionName).toBe('WATCH') // empty memory keeps alerting on identical evidence
		expect(last.decisions[0].actionName).toBe('HOLD')
		const firstFlip = rs.findIndex((r) => r.decisions[0].actionName === 'HOLD')
		expect(firstFlip).toBeGreaterThan(2)
		expect(last.next.marginPoints).toBeGreaterThan(P.judge.watchMarginPoints)
		expect(last.next.voices.R2_liquidation_close.multiplierBps).toBeLessThan(10000)
		const kinds = new Set(last.record.effects.map((e) => e.kind))
		expect(kinds.has('action')).toBe(true)
		expect(kinds.has('argument_weight')).toBe(true)
		expect(kinds.has('margin')).toBe(true)
	})

	test('learning never touches the hard rule: a crash to 1.05x cover still ESCALATEs', () => {
		const rs = chain([...Array.from({ length: 30 }, (_, i) => tight(i)), tight(30, 860_000)])
		const crash = rs[rs.length - 1]
		expect(crash.decisions[0].metrics.healthBps).toBeLessThan(P.risk.escalateHealthBps)
		expect(crash.decisions[0].actionName).toBe('ESCALATE')
	})

	test('a miss pulls the margin back down and restores the bear', () => {
		const rs = chain([...Array.from({ length: 30 }, (_, i) => tight(i)), tight(30, 960_000), tight(31, 960_000)])
		const before = rs[29].next
		const after = rs[31].next
		expect(after.regret).toContain('missed')
		expect(after.marginPoints).toBeLessThan(before.marginPoints)
		expect(after.voices.R2_liquidation_close.credBps).toBeGreaterThan(before.voices.R2_liquidation_close.credBps)
	})

	test('a feed that lies gets muted and the consensus moves away from it', () => {
		const lying = (i: number) => evidence(1_000_000 + i * 3600, 1_000_000, { overrides: { okx: { priceMicros: 1_040_000 }, coingecko: { priceMicros: 1_002_000 } } })
		const rs = chain(Array.from({ length: 8 }, (_, i) => lying(i)))
		const last = rs[rs.length - 1]
		expect(last.next.sources.okx!.muted).toBe(true)
		expect(last.record.consensus.used).not.toContain('okx')
		expect(last.record.coldConsensus.used).toContain('okx')
		expect(last.record.effects.some((e) => e.kind === 'feed_excluded' && e.detail.startsWith('okx'))).toBe(true)
		// the median shrugs off one liar while plenty of feeds answer. Thin data is where memory matters:
		// if only three feeds answer and one is the remembered liar, the agent abstains instead of acting on two feeds plus a liar
		const thin = evidence(1_000_000 + 9 * 3600, 1_000_000, { overrides: { okx: { priceMicros: 1_040_000 }, coinbase: { ok: false, priceMicros: 0 }, kraken: { ok: false, priceMicros: 0 }, coingecko: { ok: false, priceMicros: 0 } } })
		const r = runStep(last.next, thin, [], P)
		expect(r.coldDecisions[0].actionName).not.toBe('ABSTAIN')
		expect(r.decisions[0].actionName).toBe('ABSTAIN')
		expect(r.record.effects.some((e) => e.kind === 'action')).toBe(true)
	})

	test('too few trusted feeds: ABSTAIN, and no claims are filed on bad data', () => {
		const e = evidence(5000, 1_000_000, { overrides: { okx: { ok: false, priceMicros: 0 }, kraken: { ok: false, priceMicros: 0 }, coinbase: { ok: false, priceMicros: 0 }, coingecko: { ok: false, priceMicros: 0 } } })
		const r = runStep(emptyState(P), e, [], P)
		expect(r.decisions[0].actionName).toBe('ABSTAIN')
		expect(r.next.pending.length).toBe(0)
	})
})

describe('duty-of-care lineage', () => {
	test('decisions are deterministic and hash-chained to the memory they recalled', () => {
		const e = evidence(1_000_000, 1_000_000)
		const a = runStep(emptyState(P), e, [{ blobId: 'blob1', kind: 'state', seq: 0 }], P)
		const b = runStep(emptyState(P), e, [{ blobId: 'blob1', kind: 'state', seq: 0 }], P)
		expect(a.record.reasoningHash).toBe(b.record.reasoningHash)
		expect(a.next.prevStateHash).toBe(stateHash(emptyState(P)))
		const c = runStep(emptyState(P), e, [{ blobId: 'blob2', kind: 'state', seq: 0 }], P)
		expect(c.record.reasoningHash).not.toBe(a.record.reasoningHash) // the cited memory is part of the reasoning
	})
	test('a real mainnet run (Tatum evidence, Oct 22 2026) replays bit for bit', () => {
		const r = runStep((run1 as any).priorState, (run1 as any).evidence, (run1 as any).record.recalled, P)
		expect(r.record.reasoningHash).toBe((run1 as any).record.reasoningHash)
		expect(stateHash(r.next)).toBe((run1 as any).record.nextStateHash)
	})
})

describe('novelty guard', () => {
	const tight = (i: number, price = 1_000_000) => evidence(1_000_000 + i * H, price, { usdcDebt: 6_100 })
	test('memory makes the agent calmer about the familiar, never about the new: a sudden 7% drop re-arms the alert', () => {
		let s = emptyState(P)
		let calm: ReturnType<typeof runStep> | undefined
		for (let i = 0; i < 30; i++) { calm = runStep(s, tight(i), [], P); s = calm.next }
		expect(calm!.decisions[0].actionName).toBe('HOLD') // learned: these alerts were noise
		const shock = runStep(s, tight(30, 930_000), [], P)
		expect(shock.decisions[0].metrics.healthBps).toBeGreaterThan(P.risk.escalateHealthBps) // not a hard-rule case
		expect(shock.decisions[0].actionName).toBe('WATCH')
		expect(shock.record.effects.some((e) => e.kind === 'novelty_guard')).toBe(true)
	})
})
