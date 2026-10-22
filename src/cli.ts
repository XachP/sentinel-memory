#!/usr/bin/env bun
// Sentinel Memory CLI.
//   run    [--memory walrus|local] [--no-write] [--skip-if-fresh SEC]   one cycle: recall -> Tatum evidence -> decide (with and without memory) -> remember
//   replay <docs/data/runs/NNNN.json>             re-derive a past decision bit for bit from its saved evidence and recalled state
//   ab                                            replay every saved run twice, chained memory vs no memory, and write the scorecard
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyState, stateHash, type MemoryState } from './core/learn'
import { POLICY_V1, policyHash } from './core/policy'
import { runStep, type MemoryRef } from './core/step'
import { scorecard } from './core/scorecard'
import { decisionItem, lessonItems, NS, pickState, stateItem, STATE_QUERY } from './memory/records'
import { LocalStore, type MemoryStore } from './memory/store'
import { collect, type Watch } from './sources/collect'
import { TatumSui } from './sources/tatum'

const DATA = process.env.SM_DATA_DIR ?? 'docs/data'
const RUNS = join(DATA, 'runs')
const args = process.argv.slice(2)
const flag = (name: string, dflt?: string) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true') : dflt
}

function watchlist(): Watch[] {
	const env = process.env.WATCH_OBLIGATIONS
	if (env) return env.split(',').map((x) => { const [obligationId, label] = x.split(':'); return { obligationId, label: label ?? obligationId.slice(0, 10) } })
	return JSON.parse(readFileSync('config/watch.json', 'utf8')).obligations
}

async function store(kind: string): Promise<MemoryStore> {
	if (kind === 'local') return new LocalStore(process.env.LOCAL_MEMORY_FILE ?? '.memory-local/memories.jsonl')
	const { WalrusStore } = await import('./memory/walrus')
	return new WalrusStore()
}

async function cmdRun() {
	const mem = await store(flag('memory', process.env.MEMORY_BACKEND ?? 'walrus')!)
	const write = flag('no-write') !== 'true'
	// 1. recall: the newest intact state snapshot
	let prior: MemoryState = emptyState(POLICY_V1)
	const recalled: MemoryRef[] = []
	let memoryStatus = 'cold start (no snapshot yet)'
	try {
		const hits = await mem.recall(STATE_QUERY, NS.state, 10)
		const best = pickState(hits)
		if (best) {
			prior = best.state
			recalled.push({ blobId: best.blobId, kind: 'state', seq: best.state.seq })
			memoryStatus = `recalled state #${best.state.seq} from ${best.blobId}`
		}
	} catch (e) {
		// duty of care: without memory we can still decide (hard rules need no memory), but we must not overwrite it
		memoryStatus = `memory unreachable (${(e as Error).message}); deciding cold and NOT writing`
		if (mem.backend === 'walrus-mainnet') process.exitCode = 2
	}
	const memoryOk = !memoryStatus.startsWith('memory unreachable')
	// watchdog mode (box fallback): do nothing if another runner already ran recently
	const fresh = Number(flag('skip-if-fresh', '0'))
	if (fresh > 0 && memoryOk && prior.updatedAt > 0 && Math.floor(Date.now() / 1000) - prior.updatedAt < fresh) {
		console.log(`[sentinel-memory] ${memoryStatus}; last run ${Math.floor(Date.now() / 1000) - prior.updatedAt}s ago < ${fresh}s, skipping (another runner is active)`)
		return
	}
	// 2. evidence via Tatum
	const tatum = new TatumSui()
	const { evidence } = await collect(watchlist(), tatum)
	// 3. decide
	const res = runStep(prior, evidence, recalled, POLICY_V1)
	// 4. remember
	const items = [stateItem(res.next), decisionItem(res.record), ...lessonItems(res.record, res.muteChanges)]
	const written = write && memoryOk ? await mem.rememberAll(items) : []
	const memoryNotes = (mem as any).log ?? []
	// 5. publish the run for the dashboard (nothing secret in here)
	mkdirSync(RUNS, { recursive: true })
	const run = { seq: res.next.seq, backend: mem.backend, memoryStatus, memoryNotes, tatum: { authenticated: tatum.authenticated, calls: tatum.log }, evidence, priorState: prior, record: res.record, nextState: res.next, written, policyHash: policyHash() }
	const file = join(RUNS, `${String(res.next.seq).padStart(5, '0')}.json`)
	writeFileSync(file, JSON.stringify(run, null, 1))
	writeIndex()
	console.log(`[sentinel-memory] ${memoryStatus}`)
	console.log(`[sentinel-memory] checkpoint ${evidence.checkpoint}; consensus SUI $${(res.record.consensus.priceMicros / 1e6).toFixed(4)} from ${res.record.consensus.used.join(', ')}; excluded: ${res.record.consensus.excluded.map((x) => x.source + ' (' + x.reason + ')').join('; ') || 'none'}`)
	for (const [i, d] of res.decisions.entries()) console.log(`  ${d.label.padEnd(24)} ${d.actionName.padEnd(8)} cover ${(d.metrics.healthBps / 10000).toFixed(3)}x  drop-to-liq ${(d.metrics.gapBps / 100).toFixed(1)}%  bull ${d.bull.score} bear ${d.bear.score} margin ${d.marginPoints}  | empty memory: ${res.coldDecisions[i].actionName} (bull ${res.coldDecisions[i].bull.score} bear ${res.coldDecisions[i].bear.score})`)
	console.log(`  memory effects: ${res.record.effects.length ? res.record.effects.map((e) => e.detail).join(' | ') : 'none'}`)
	console.log(`  resolved ${res.record.resolutions.length} forecasts, ${res.record.alertResolutions.length} alerts; wrote ${written.length} memories${written.length ? ': ' + written.map((w) => `${w.kind}=${w.blobId}`).join(', ') : ''}`)
	for (const n of memoryNotes) console.log(`  memory note: ${n}`)
	console.log(`  saved ${file}`)
}

function loadRuns() {
	if (!existsSync(RUNS)) return []
	return readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(RUNS, f), 'utf8')))
}

function writeIndex() {
	const runs = loadRuns()
	const index = runs.map((r) => ({
		seq: r.seq, observedAt: r.evidence.observedAt, checkpoint: r.evidence.checkpoint, backend: r.backend,
		consensus: r.record.consensus.priceMicros, used: r.record.consensus.used, excluded: r.record.consensus.excluded.map((x: any) => x.source),
		decisions: r.record.decisions.map((d: any) => ({ label: d.label, action: d.action, bull: d.bull, bear: d.bear, margin: d.margin, healthBps: d.healthBps, gapBps: d.gapBps })),
		cold: r.record.coldDecisions.map((d: any) => ({ action: d.action, bull: d.bull, bear: d.bear })),
		effects: r.record.effects.length, resolutions: r.record.resolutions.length, written: r.written.length,
		trust: Object.fromEntries(Object.entries(r.nextState.sources).map(([k, v]: any) => [k, { trustBps: v.trustBps, muted: v.muted, last: v.last }])),
		voices: Object.fromEntries(Object.entries(r.nextState.voices).map(([k, v]: any) => [k, { credBps: v.credBps, n: v.n, multiplierBps: v.multiplierBps }])),
		margin: r.nextState.marginPoints,
		reasoningHash: r.record.reasoningHash,
	}))
	writeFileSync(join(DATA, 'index.json'), JSON.stringify({ policy: POLICY_V1, policyHash: policyHash(), runs: index }, null, 1))
	if (runs.length) writeFileSync(join(DATA, 'latest.json'), JSON.stringify(runs[runs.length - 1], null, 1))
}

function cmdReplay() {
	const file = args[1]
	if (!file) throw new Error('usage: replay docs/data/runs/00001.json')
	const run = JSON.parse(readFileSync(file, 'utf8'))
	const res = runStep(run.priorState, run.evidence, run.record.recalled, POLICY_V1)
	const ok = res.record.reasoningHash === run.record.reasoningHash && stateHash(res.next) === run.record.nextStateHash && stateHash(run.priorState) === run.record.priorStateHash
	console.log(`${ok ? 'MATCH' : 'MISMATCH'} run #${run.seq}: reasoningHash ${res.record.reasoningHash}, nextStateHash ${stateHash(res.next)}`)
	if (!ok) process.exit(1)
}

function cmdAb() {
	const runs = loadRuns()
	const sc = scorecard(runs.map((r) => r.evidence), POLICY_V1)
	writeFileSync(join(DATA, 'scorecard.json'), JSON.stringify(sc, null, 1))
	console.log(JSON.stringify(sc.summary, null, 1))
}

const cmd = args[0] ?? 'run'
if (cmd === 'run') await cmdRun()
else if (cmd === 'replay') cmdReplay()
else if (cmd === 'ab') cmdAb()
else if (cmd === 'index') writeIndex()
else throw new Error(`unknown command ${cmd}`)
