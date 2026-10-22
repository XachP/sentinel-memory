// What gets written to Walrus Memory. Each memory is a plain-English line, which is good for semantic recall and
// readable by a judge, followed by a machine line `#SM1 <canonical json>` that the agent parses back. The STATE
// memory is what the next run recalls and conditions on. Its hash is written next to it, so a tampered or
// truncated recall is rejected.
import { canonicalize } from '../core/canonical'
import { stateHash, STATE_SCHEMA, type MemoryState } from '../core/learn'
import type { DecisionRecord } from '../core/step'
import { pct, usd } from '../core/math'

export const NS = {
	state: 'sentinel-memory.state',
	decisions: 'sentinel-memory.decisions',
	lessons: 'sentinel-memory.lessons',
} as const

export const STATE_QUERY = 'Sentinel Memory state snapshot: feed trust, argument credibility, alert margin'
const MARK = '\n#SM1 '

export type Item = { namespace: string; text: string; kind: 'state' | 'decision' | 'lesson'; seq: number }

export function stateItem(s: MemoryState): Item {
	const feeds = Object.entries(s.sources)
		.map(([k, t]) => `${k} ${(t!.trustBps / 100).toFixed(0)}%${t!.muted ? ' (MUTED)' : ''}`)
		.join(', ')
	const voices = Object.entries(s.voices)
		.sort((a, b) => b[1].n - a[1].n)
		.slice(0, 6)
		.map(([k, v]) => `${k} ${(v.credBps / 100).toFixed(0)}% x${(v.multiplierBps / 10000).toFixed(2)}`)
		.join(', ')
	const head = `Sentinel Memory state snapshot #${s.seq} (${new Date(s.updatedAt * 1000).toISOString()}). Feed trust: ${feeds || 'none yet'}. Argument credibility: ${voices || 'none resolved yet'}. Alert margin ${s.marginPoints} points. stateHash ${stateHash(s)}.`
	return { namespace: NS.state, kind: 'state', seq: s.seq, text: head + MARK + canonicalize({ kind: 'state', hash: stateHash(s), state: s }) }
}

export function decisionItem(r: DecisionRecord): Item {
	const acts = r.decisions.map((d) => `${d.label}: ${d.action} (bull ${d.bull} / bear ${d.bear}, margin ${d.margin}, cover ${(d.healthBps / 10000).toFixed(3)}x, drop-to-liq ${pct(d.gapBps)})`).join('; ')
	const cold = r.coldDecisions.map((d) => d.action).join('/')
	const head = `Sentinel Memory decision #${r.seq} at checkpoint ${r.checkpoint}. Consensus SUI ${usd(r.consensus.priceMicros)} from ${r.consensus.used.join(', ')}. ${acts}. With empty memory it would have said ${cold}. Memory effects: ${r.effects.length ? r.effects.map((e) => e.detail).join('; ') : 'none'}. reasoningHash ${r.reasoningHash}.`
	return { namespace: NS.decisions, kind: 'decision', seq: r.seq, text: head + MARK + canonicalize({ kind: 'decision', record: r }) }
}

/** Short human lessons: mute and unmute events, plus a roll-up of this run's resolved forecasts and alerts. */
export function lessonItems(r: DecisionRecord, muteChanges: { source: string; muted: boolean; trustBps: number }[]): Item[] {
	const out: Item[] = []
	for (const m of muteChanges)
		out.push({
			namespace: NS.lessons, kind: 'lesson', seq: r.seq,
			text: `Lesson #${r.seq}: price feed ${m.source} ${m.muted ? 'is now MUTED and excluded from consensus' : 'has earned its way back into consensus'} (trust ${pct(m.trustBps)}).` + MARK + canonicalize({ kind: 'lesson', type: 'feed', seq: r.seq, ...m }),
		})
	if (r.resolutions.length) {
		const right = r.resolutions.filter((x) => x.right).length
		const byArg = new Map<string, [number, number]>()
		for (const x of r.resolutions) {
			const v = byArg.get(x.argId) ?? [0, 0]
			v[x.right ? 0 : 1]++
			byArg.set(x.argId, v)
		}
		const alerts = r.alertResolutions.filter((a) => a.outcome !== 'ok').map((a) => `${a.action} ${a.outcome}`)
		out.push({
			namespace: NS.lessons, kind: 'lesson', seq: r.seq,
			text: `Lesson #${r.seq}: checked ${r.resolutions.length} matured forecasts, ${right} right. ${[...byArg].map(([k, [a, b]]) => `${k} ${a}/${a + b}`).join(', ')}.${alerts.length ? ` Alerts: ${alerts.join(', ')}.` : ''}` + MARK + canonicalize({ kind: 'lesson', type: 'outcomes', seq: r.seq, resolutions: r.resolutions, alerts: r.alertResolutions }),
		})
	}
	return out
}

export function parseMachine(text: string): any | null {
	const i = text.lastIndexOf(MARK)
	if (i < 0) return null
	try { return JSON.parse(text.slice(i + MARK.length)) } catch { return null }
}

/** Pick the newest intact state snapshot out of recalled memories. A hash mismatch counts as corrupt and is skipped. */
export function pickState(recalled: { blobId: string; text: string }[]): { state: MemoryState; blobId: string } | null {
	let best: { state: MemoryState; blobId: string } | null = null
	for (const r of recalled) {
		const j = parseMachine(r.text)
		if (!j || j.kind !== 'state' || j.state?.schema !== STATE_SCHEMA) continue
		if (stateHash(j.state) !== j.hash) continue
		if (!best || j.state.seq > best.state.seq) best = { state: j.state, blobId: r.blobId }
	}
	return best
}
