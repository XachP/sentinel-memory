import { describe, expect, test } from 'bun:test'
import { consensus, emptyState, gradeFeeds, marginFrom, multiplierFor, resolvePending, updateFeeds, type MemoryState } from '../src/core/learn'
import { forecastOf } from '../src/core/agents'
import { POLICY_V1 as P } from '../src/core/policy'
import { evidence } from './helpers'

describe('loop 1: feed reliability', () => {
	test('grades: agree, deviate, stale, error', () => {
		const e = evidence(10_000, 1_000_000, { overrides: { okx: { priceMicros: 1_020_000 }, kraken: { ts: 10_000 - 900 }, coingecko: { ok: false, priceMicros: 0, detail: 'HTTP 429' } } })
		const g = gradeFeeds(e, P).grades
		expect(g.coinbase?.outcome).toBe('agree')
		expect(g.okx?.outcome).toBe('deviate')
		expect(g.okx?.devBps).toBe(200)
		expect(g.kraken?.outcome).toBe('stale')
		expect(g.coingecko?.outcome).toBe('error')
	})
	test('a feed that keeps deviating is muted after enough observations and leaves the consensus', () => {
		let s = emptyState(P).sources
		const bad = (t: number) => evidence(t, 1_000_000, { overrides: { okx: { priceMicros: 1_030_000 } } })
		for (let i = 0; i < P.memory.minObservations - 1; i++) s = updateFeeds(s, gradeFeeds(bad(1000 + i), P).grades, P)
		expect(s.okx!.muted).toBe(false) // not enough evidence yet
		s = updateFeeds(s, gradeFeeds(bad(2000), P).grades, P)
		expect(s.okx!.muted).toBe(true)
		expect(s.coinbase!.muted).toBe(false)
		const c = consensus(bad(3000), s, P)
		expect(c.used).not.toContain('okx')
		expect(c.excluded.find((x) => x.source === 'okx')?.reason).toStartWith('muted by memory')
	})
	test('hysteresis: a muted feed must climb above unmuteAbove to rejoin', () => {
		let s = emptyState(P).sources
		for (let i = 0; i < 8; i++) s = updateFeeds(s, gradeFeeds(evidence(i, 1_000_000, { overrides: { okx: { priceMicros: 1_050_000 } } }), P).grades, P)
		expect(s.okx!.muted).toBe(true)
		let rounds = 0
		while (s.okx!.muted && rounds < 100) { s = updateFeeds(s, gradeFeeds(evidence(100 + rounds, 1_000_000), P).grades, P); rounds++ }
		expect(s.okx!.muted).toBe(false)
		expect(s.okx!.trustBps).toBeGreaterThanOrEqual(P.memory.unmuteAboveBps)
		expect(rounds).toBeGreaterThan(3) // earning trust back takes a streak
	})
})

describe('loops 2 and 3: argument credibility and regret', () => {
	const base = (): MemoryState => ({
		...emptyState(P),
		pending: [{ seq: 1, madeAt: 0, dueAt: 100, priceMicros: 1_000_000, items: [{ obligationId: '0xaaa', gapBps: 3000, healthBps: 14000, action: 'WATCH', args: ['R4_momentum_down', 'B1_health_headroom'] }] }],
	})
	test('nothing resolves before the horizon', () => {
		const r = resolvePending(base(), { at: 99, priceMicros: 1_000_000, gapBps: { '0xaaa': 3000 }, healthBps: { '0xaaa': 14000 } }, forecastOf, P)
		expect(r.resolved.length).toBe(0)
		expect(r.pending.length).toBe(1)
	})
	test('a flat market: the bear momentum call was wrong, the bull call right, and the WATCH was a false alarm', () => {
		const r = resolvePending(base(), { at: 200, priceMicros: 1_001_000, gapBps: { '0xaaa': 3000 }, healthBps: { '0xaaa': 14010 } }, forecastOf, P)
		expect(r.resolved.find((x) => x.argId === 'R4_momentum_down')!.right).toBe(false)
		expect(r.resolved.find((x) => x.argId === 'B1_health_headroom')!.right).toBe(true)
		expect(r.alerts[0].outcome).toBe('false_alarm')
		expect(r.pending.length).toBe(0)
	})
	test('a real drop: the bear was right and the WATCH justified', () => {
		const r = resolvePending(base(), { at: 200, priceMicros: 950_000, gapBps: { '0xaaa': 2600 }, healthBps: { '0xaaa': 13300 } }, forecastOf, P)
		expect(r.resolved.find((x) => x.argId === 'R4_momentum_down')!.right).toBe(true)
		expect(r.alerts[0].outcome).toBe('justified')
	})
	test('no trusted price now: keep the claim open instead of guessing', () => {
		const r = resolvePending(base(), { at: 200, priceMicros: 0, gapBps: {}, healthBps: {} }, forecastOf, P)
		expect(r.resolved.length).toBe(0)
		expect(r.pending.length).toBe(1)
	})
	test('credibility multipliers stay inside policy bounds and need minResolutions', () => {
		expect(multiplierFor({ side: 'bear', a: 0, b: 100000, n: 1, credBps: 0, multiplierBps: 0, lastResult: 'wrong' }, P)).toBe(10000)
		expect(multiplierFor({ side: 'bear', a: 0, b: 100000, n: 9, credBps: 0, multiplierBps: 0, lastResult: 'wrong' }, P)).toBe(P.memory.multiplierFloorBps)
		expect(multiplierFor({ side: 'bull', a: 100000, b: 0, n: 9, credBps: 10000, multiplierBps: 0, lastResult: 'right' }, P)).toBe(P.memory.multiplierCeilBps)
	})
	test('margin: false alarms raise it, misses lower it twice as hard, and it stays within bounds', () => {
		expect(marginFrom([], P)).toBe(150)
		expect(marginFrom(['false_alarm', 'false_alarm', 'false_alarm'], P)).toBe(180)
		expect(marginFrom(['false_alarm', 'missed'], P)).toBe(140)
		expect(marginFrom(Array(50).fill('false_alarm'), P)).toBe(P.memory.marginMaxPoints)
		expect(marginFrom(Array(50).fill('missed'), P)).toBe(P.memory.marginMinPoints)
	})
})
