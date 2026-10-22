import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyState } from '../src/core/learn'
import { POLICY_V1 as P } from '../src/core/policy'
import { runStep } from '../src/core/step'
import { scorecard } from '../src/core/scorecard'
import { decisionItem, lessonItems, NS, parseMachine, pickState, stateItem, STATE_QUERY } from '../src/memory/records'
import { LocalStore } from '../src/memory/store'
import { cetusQuote, fetchOffchain } from '../src/sources/feeds'
import { evidence } from './helpers'

describe('memory records', () => {
	const r = runStep(emptyState(P), evidence(1_000_000, 1_000_000), [], P)
	test('state snapshot round-trips, and the newest intact snapshot wins', () => {
		const a = stateItem(r.next)
		const r2 = runStep(r.next, evidence(1_003_600, 1_000_000), [], P)
		const b = stateItem(r2.next)
		expect(a.text).toStartWith('Sentinel Memory state snapshot #1')
		const best = pickState([{ blobId: 'A', text: a.text }, { blobId: 'B', text: b.text }])
		expect(best?.blobId).toBe('B')
		expect(best?.state).toEqual(r2.next)
	})
	test('a tampered snapshot is rejected (hash mismatch)', () => {
		const t = stateItem(r.next).text.replace('"marginPoints":150', '"marginPoints":80')
		expect(pickState([{ blobId: 'X', text: t }])).toBeNull()
	})
	test('decision and lesson memories are readable and machine-parseable', () => {
		const d = decisionItem(r.record)
		expect(d.namespace).toBe(NS.decisions)
		expect(d.text).toContain('With empty memory it would have said')
		expect(parseMachine(d.text).record.reasoningHash).toBe(r.record.reasoningHash)
		const l = lessonItems(r.record, [{ source: 'okx', muted: true, trustBps: 4200 }])
		expect(l[0].text).toContain('okx is now MUTED')
	})
	test('LocalStore: remember then recall by namespace, newest first', async () => {
		const s = new LocalStore(join(mkdtempSync(join(tmpdir(), 'sm-')), 'm.jsonl'))
		const w = await s.rememberAll([stateItem(r.next), decisionItem(r.record)])
		expect(w[0].blobId).toStartWith('local:')
		const got = await s.recall(STATE_QUERY, NS.state, 5)
		expect(got.length).toBe(1)
		expect(pickState(got)?.state.seq).toBe(1)
	})
})

describe('feeds', () => {
	test('Cetus USDC/SUI price from sqrt_price (real mainnet value)', () => {
		expect(cetusQuote({ current_sqrt_price: '587438836345140412416', is_pause: false }, 0).priceMicros).toBe(986084)
		expect(cetusQuote(undefined, 0).ok).toBe(false)
	})
	test('every feed failure becomes an error quote, and keyed feeds are skipped without a key', async () => {
		const f = (async () => new Response('nope', { status: 451 })) as unknown as typeof fetch
		const q = await fetchOffchain(1000, '', f)
		expect(q.every((x) => !x.ok)).toBe(true)
		expect(q.find((x) => x.source === 'tatum_rate')).toBeUndefined()
		const withKey = await fetchOffchain(1000, 'k', f)
		expect(withKey.find((x) => x.source === 'tatum_rate')?.ok).toBe(false)
	})
})

describe('A/B scorecard', () => {
	test('replaying the same evidence: memory cuts false alarms without adding misses', () => {
		const es = Array.from({ length: 30 }, (_, i) => evidence(1_000_000 + i * (P.memory.horizonSec + 600), 1_000_000, { usdcDebt: 6_100 }))
		const sc = scorecard(es, P).summary
		expect(sc.runs).toBe(30)
		expect(sc.emptyMemory.falseAlarms).toBeGreaterThan(sc.withMemory.falseAlarms)
		expect(sc.withMemory.missed).toBe(0)
		expect(sc.decisionsWhereMemoryChangedAction).toBeGreaterThan(0)
	})
})

describe('walrus manual-mode embedding', () => {
	test('local feature-hash embedding is deterministic, 1536-d and unit length', async () => {
		const { hashEmbed, EMBED_DIM } = await import('../src/memory/walrus')
		const a = hashEmbed('Sentinel Memory state snapshot #3 feed trust okx 40%')
		expect(a.length).toBe(EMBED_DIM)
		expect(hashEmbed('Sentinel Memory state snapshot #3 feed trust okx 40%')).toEqual(a)
		expect(Math.abs(Math.sqrt(a.reduce((s, x) => s + x * x, 0)) - 1)).toBeLessThan(1e-9)
		expect(hashEmbed('x\n#SM1 {"ignored":true}')).toEqual(hashEmbed('x'))
	})
})
