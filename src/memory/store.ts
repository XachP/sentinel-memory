// The memory interface the agent depends on. WalrusStore (mainnet, the real one) and LocalStore (a JSONL file for
// tests and offline dry runs, clearly labelled `local:` in every blob id) both implement it.
import { mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { keccak256, stringToBytes } from 'viem'
import type { Item } from './records'

export type Recalled = { blobId: string; text: string; createdAt?: string }
export type Written = { blobId: string; namespace: string; kind: string; seq: number }

export interface MemoryStore {
	readonly backend: 'walrus-mainnet' | 'local'
	recall(query: string, namespace: string, limit: number): Promise<Recalled[]>
	rememberAll(items: Item[]): Promise<Written[]>
}

export class LocalStore implements MemoryStore {
	readonly backend = 'local' as const
	constructor(private file = '.memory-local/memories.jsonl') {}
	private all(): (Recalled & { namespace: string })[] {
		if (!existsSync(this.file)) return []
		return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
	}
	async recall(_query: string, namespace: string, limit: number) {
		return this.all().filter((m) => m.namespace === namespace).reverse().slice(0, limit)
	}
	async rememberAll(items: Item[]) {
		mkdirSync(dirname(this.file), { recursive: true })
		return items.map((it) => {
			const blobId = `local:${keccak256(stringToBytes(it.text)).slice(2, 18)}`
			appendFileSync(this.file, JSON.stringify({ blobId, namespace: it.namespace, text: it.text, createdAt: new Date().toISOString() }) + '\n')
			return { blobId, namespace: it.namespace, kind: it.kind, seq: it.seq }
		})
	}
}
