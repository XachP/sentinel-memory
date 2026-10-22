// Walrus Memory on Sui mainnet through the hosted relayer (relayer.memory.walrus.xyz). The relayer uploads to
// Walrus and pays WAL storage and SUI gas. The agent holds only a delegate key (MEMWAL_PRIVATE_KEY) registered on
// the owner's MemWal account (MEMWAL_ACCOUNT_ID).
//
// Two write paths:
//  - standard: relayer embeds + SEAL-encrypts (rememberBulkAndWait).
//  - manual:   we SEAL-encrypt locally and send our own embedding (deterministic feature hashing, 1536-d). The
//              relayer still uploads to Walrus. This keeps the agent writing while the relayer's embedding provider
//              is down (seen Oct 22, 2026: "Embedding API error (401)").
// Recall needs no embeddings at all: list the account's memories (metadata), take the newest blobs in the
// namespace, download them from the Walrus aggregator and SEAL-decrypt them with a delegate-signed session key.
import { MemWal } from '@mysten-incubation/memwal'
import { MemWalManual } from '@mysten-incubation/memwal/manual'
import { encodeSuiPrivateKey } from '@mysten/sui/cryptography'
import type { Item } from './records'
import type { MemoryStore, Recalled, Written } from './store'

export const MAINNET_RELAYER = 'https://relayer.memory.walrus.xyz'
export const MAINNET_PACKAGE_ID = '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5'
export const MAINNET_REGISTRY_ID = '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f'
export const EMBED_DIM = 1536

/** Deterministic bag-of-words feature hashing into 1536 dims, L2-normalised. Not semantic, but stable and local. */
export function hashEmbed(text: string, dim = EMBED_DIM): number[] {
	const v = new Array<number>(dim).fill(0)
	const head = text.split('\n#SM1 ')[0].toLowerCase()
	for (const tok of head.match(/[a-z0-9_]+/g) ?? []) {
		let h = 2166136261
		for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0
		v[h % dim] += h & 0x80000000 ? -1 : 1
	}
	const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
	return v.map((x) => x / n)
}

const hexToBytes = (h: string) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)!.map((b) => parseInt(b, 16)))

export type WriteMode = 'auto' | 'standard' | 'manual'

export class WalrusStore implements MemoryStore {
	readonly backend = 'walrus-mainnet' as const
	readonly log: string[] = []
	private mw: MemWal
	private manual: any
	private pinned: string[] | null = null
	constructor(
		key = process.env.MEMWAL_PRIVATE_KEY ?? '',
		private accountId = process.env.MEMWAL_ACCOUNT_ID ?? '',
		serverUrl = process.env.MEMWAL_SERVER_URL ?? process.env.MEMWAL_RELAYER_URL ?? MAINNET_RELAYER,
		private mode: WriteMode = (process.env.MEMWAL_WRITE_MODE as WriteMode) ?? 'auto',
	) {
		if (!key || !accountId) throw new Error('MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID are required for the Walrus backend (or run with --memory local)')
		this.mw = MemWal.create({ key, accountId, serverUrl, namespace: 'sentinel-memory.state' })
		const seed = hexToBytes(key)
		this.manual = MemWalManual.create({
			key, serverUrl, accountId,
			suiPrivateKey: encodeSuiPrivateKey(seed, 'ED25519'), // the delegate key also signs the SEAL session (personal message, no gas)
			embeddingApiKey: 'local-hash-embedding', // never sent anywhere: embed() is replaced below
			packageId: process.env.MEMWAL_PACKAGE_ID ?? MAINNET_PACKAGE_ID,
			registryId: process.env.MEMWAL_REGISTRY_ID ?? MAINNET_REGISTRY_ID,
			suiNetwork: 'mainnet',
			namespace: 'sentinel-memory.state',
		} as any)
		this.manual.embed = async (text: string) => hashEmbed(text)
		// pin the search step of recallManual to blob ids we chose from the inventory, then let the SDK download + decrypt
		const signed = this.manual.signedRequest.bind(this.manual)
		this.manual.signedRequest = async (method: string, path: string, body: unknown) => {
			if (path === '/api/recall/manual' && this.pinned) return { results: this.pinned.map((b) => ({ blob_id: b, distance: 0 })), total: this.pinned.length }
			return signed(method, path, body)
		}
	}
	client() { return this.mw }

	/** Newest memories of a namespace, from the account inventory (no embeddings involved). */
	async newest(namespace: string, limit: number) {
		const all: { blob_id: string; created_at: string; namespace_id: string; status: string }[] = []
		let cursor: string | undefined
		for (let page = 0; page < 50; page++) {
			const r = await this.mw.listMemories({ cursor, limit: 500 })
			all.push(...(r.memories as any[]))
			if (!r.has_more || !r.next_cursor) break
			cursor = r.next_cursor
		}
		return all.filter((m) => m.namespace_id === namespace && m.blob_id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
	}

	async recall(_query: string, namespace: string, limit: number): Promise<Recalled[]> {
		const top = await this.newest(namespace, limit)
		if (!top.length) return []
		this.pinned = top.map((m) => m.blob_id)
		try {
			const r = await this.manual.recallManual('pinned', { limit: top.length, namespace })
			const created = new Map(top.map((m) => [m.blob_id, m.created_at]))
			return (r.results as { blob_id: string; text: string }[]).map((m) => ({ blobId: m.blob_id, text: m.text, createdAt: created.get(m.blob_id) }))
		} finally {
			this.pinned = null
		}
	}

	private async writeManual(it: Item): Promise<Written> {
		const r = await this.manual.rememberManual(it.text, it.namespace)
		if (!r.blob_id) throw new Error(`manual remember returned no blob_id for ${it.kind} #${it.seq}`)
		return { blobId: r.blob_id, namespace: it.namespace, kind: it.kind, seq: it.seq }
	}

	async rememberAll(items: Item[]): Promise<Written[]> {
		if (this.mode === 'manual') return this.sequential(items)
		const out: (Written | null)[] = items.map(() => null)
		for (let i = 0; i < items.length; i += 20) {
			const chunk = items.slice(i, i + 20)
			try {
				const res = await this.mw.rememberBulkAndWait(chunk.map((c) => ({ text: c.text, namespace: c.namespace })))
				res.results.forEach((r, j) => {
					if (r.blob_id && r.status === 'done') out[i + j] = { blobId: r.blob_id, namespace: chunk[j].namespace, kind: chunk[j].kind, seq: chunk[j].seq }
					else this.log.push(`standard remember failed for ${chunk[j].kind} #${chunk[j].seq}: ${String(r.error ?? r.status).slice(0, 120)}`)
				})
			} catch (e) {
				this.log.push(`standard bulk remember failed: ${String((e as Error).message).slice(0, 160)}`)
			}
		}
		const missing = items.filter((_, k) => !out[k])
		if (missing.length && this.mode === 'standard') throw new Error(this.log.join('; '))
		if (missing.length) this.log.push(`writing ${missing.length} item(s) in manual mode (local SEAL encryption + local embedding)`)
		for (let k = 0; k < items.length; k++) if (!out[k]) out[k] = await this.writeManual(items[k])
		return out as Written[]
	}

	private async sequential(items: Item[]) {
		const out: Written[] = []
		for (const it of items) out.push(await this.writeManual(it)) // state first: it is the one the next run needs
		return out
	}
}
