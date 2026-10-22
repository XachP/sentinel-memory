// Tatum Sui RPC client. Every on-chain read in Sentinel Memory goes through Tatum's Sui mainnet gateway.
// With TATUM_API_KEY set it uses the authenticated plan. Without a key the anonymous plan allows 5 requests/min,
// so a whole run is kept to 3 requests (checkpoint, checkpoint time, one multiGetObjects).
export const TATUM_SUI_MAINNET = 'https://sui-mainnet.gateway.tatum.io'

export type RpcLog = { method: string; ms: number; status: number }

export class TatumSui {
	readonly log: RpcLog[] = []
	constructor(
		private apiKey = process.env.TATUM_API_KEY ?? '',
		private url = process.env.TATUM_SUI_URL ?? TATUM_SUI_MAINNET,
		private fetchFn: typeof fetch = fetch,
	) {}

	get authenticated() { return this.apiKey.length > 0 }

	async call<T>(method: string, params: unknown[], attempt = 0): Promise<T> {
		const t0 = Date.now()
		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (this.apiKey) headers['x-api-key'] = this.apiKey
		const res = await this.fetchFn(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
		this.log.push({ method, ms: Date.now() - t0, status: res.status })
		if (res.status === 429 && attempt < 2) {
			const wait = Math.min(65, Number(res.headers.get('retry-after') ?? '20')) * 1000
			await new Promise((r) => setTimeout(r, wait))
			return this.call(method, params, attempt + 1)
		}
		if (!res.ok) throw new Error(`tatum ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
		const j = (await res.json()) as { result?: T; error?: { message: string } }
		if (j.error) throw new Error(`tatum ${method}: ${j.error.message}`)
		return j.result as T
	}

	latestCheckpoint() { return this.call<string>('sui_getLatestCheckpointSequenceNumber', []) }
	checkpoint(seq: string) { return this.call<{ sequenceNumber: string; timestampMs: string; digest: string }>('sui_getCheckpoint', [seq]) }
	multiGetObjects(ids: string[]) { return this.call<{ data?: { objectId: string; version: string; content?: { type: string; fields: any } }; error?: unknown }[]>('sui_multiGetObjects', [ids, { showContent: true }]) }
}
