// Build a SYNTHETIC dataset for previewing the dashboard locally (never published; real data comes from the cron).
// Usage: SM_DATA_DIR=/tmp/sm-preview bun scripts/preview-data.ts && SM_DATA_DIR=/tmp/sm-preview bun src/cli.ts index
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyState } from '../src/core/learn'
import { POLICY_V1 as P, policyHash } from '../src/core/policy'
import { runStep } from '../src/core/step'
import { evidence } from '../test/helpers'

const dir = process.env.SM_DATA_DIR
if (!dir || dir.startsWith('docs')) throw new Error('set SM_DATA_DIR to a scratch directory, not docs/')
mkdirSync(join(dir, 'runs'), { recursive: true })
let s = emptyState(P)
for (let i = 0; i < 40; i++) {
	const price = i < 34 ? 1_000_000 + ((i * 7919) % 9) * 1000 : 930_000
	const e = evidence(1_790_000_000 + i * 3 * 3600, price, { usdcDebt: 6_100, overrides: { okx: { priceMicros: price + 35_000 }, binance: undefined } })
	const recalled = i ? [{ blobId: `local:preview${i - 1}`, kind: 'state', seq: s.seq }] : []
	const r = runStep(s, e, recalled, P)
	writeFileSync(join(dir, 'runs', `${String(r.next.seq).padStart(5, '0')}.json`), JSON.stringify({ seq: r.next.seq, backend: 'local', memoryStatus: 'SYNTHETIC PREVIEW', tatum: {}, evidence: e, priorState: s, record: r.record, nextState: r.next, written: [{ kind: 'state', blobId: `local:preview${i}` }], policyHash: policyHash() }))
	s = r.next
}
console.log('wrote 40 synthetic runs to', dir)
