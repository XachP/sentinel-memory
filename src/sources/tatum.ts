// Tatum Sui client. Every on-chain read in Sentinel Memory goes through Tatum's Sui mainnet gateway.
// JSON-RPC on this host was removed (it now returns HTTP 404). The gateway serves GraphQL at /graphql.
// With TATUM_API_KEY set it uses the authenticated plan. Without a key the anonymous plan allows 5 requests/min,
// so a whole run is one GraphQL request: the latest checkpoint plus every object the run needs.
export const TATUM_SUI_MAINNET = 'https://sui-mainnet.gateway.tatum.io/graphql'

const READ_QUERY = `query SentinelRead($ids: [ObjectKey!]!) {
  checkpoint { sequenceNumber timestamp digest }
  multiGetObjects(keys: $ids) {
    address
    version
    asMoveObject { contents { type { repr } json } }
  }
}`

export type RpcLog = { method: string; ms: number; status: number }

export type Checkpoint = { sequenceNumber: string; timestampMs: string; digest: string }

export type ChainObject = {
	data?: { objectId: string; version: string; content?: { type: string; fields: any } }
	error?: unknown
}

type GqlObject = {
	address: string
	version: number | string
	asMoveObject: { contents: { type: { repr: string }; json: unknown } } | null
} | null

type ReadData = {
	checkpoint: { sequenceNumber: number | string; timestamp: string; digest: string } | null
	multiGetObjects: GqlObject[]
}

export class TatumSui {
	readonly log: RpcLog[] = []
	constructor(
		private apiKey = process.env.TATUM_API_KEY ?? '',
		private url = process.env.TATUM_SUI_URL ?? TATUM_SUI_MAINNET,
		private fetchFn: typeof fetch = fetch,
	) {}

	get authenticated() { return this.apiKey.length > 0 }

	async graphql<T>(query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> {
		const t0 = Date.now()
		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (this.apiKey) headers['x-api-key'] = this.apiKey
		const res = await this.fetchFn(this.url, { method: 'POST', headers, body: JSON.stringify({ query, variables }) })
		this.log.push({ method: 'graphql', ms: Date.now() - t0, status: res.status })
		if (res.status === 429 && attempt < 2) {
			const wait = Math.min(65, Number(res.headers.get('retry-after') ?? '20')) * 1000
			await new Promise((r) => setTimeout(r, wait))
			return this.graphql(query, variables, attempt + 1)
		}
		const text = await res.text()
		if (!res.ok) throw new Error(`tatum graphql: HTTP ${res.status} ${text.slice(0, 200)}`)
		const j = JSON.parse(text) as { data?: T; errors?: { message: string }[] }
		if (j.errors?.length) throw new Error(`tatum graphql: ${j.errors.map((e) => e.message).join('; ')}`)
		if (j.data == null) throw new Error('tatum graphql: empty data')
		return j.data
	}

	/** Latest checkpoint and the given objects, in one request. `content.fields` is GraphQL's flat Move json. */
	async read(ids: string[]): Promise<{ checkpoint: Checkpoint; objects: ChainObject[] }> {
		const data = await this.graphql<ReadData>(READ_QUERY, { ids: ids.map((address) => ({ address })) })
		const cp = data.checkpoint
		if (!cp) throw new Error('tatum graphql: checkpoint missing')
		const timestampMs = Date.parse(cp.timestamp)
		if (!Number.isFinite(timestampMs)) throw new Error(`tatum graphql: bad checkpoint timestamp ${cp.timestamp}`)
		const objects = (data.multiGetObjects ?? []).map((o, i): ChainObject => {
			const contents = o?.asMoveObject?.contents
			if (!o || !contents) return { error: { objectId: ids[i], message: 'object not returned' } }
			const json = typeof contents.json === 'string' ? JSON.parse(contents.json) : contents.json
			return { data: { objectId: o.address, version: String(o.version), content: { type: contents.type.repr, fields: json } } }
		})
		return { checkpoint: { sequenceNumber: String(cp.sequenceNumber), timestampMs: String(timestampMs), digest: cp.digest }, objects }
	}
}
