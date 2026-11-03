import { describe, expect, test } from 'bun:test'
import { TatumSui } from '../src/sources/tatum'

const checkpoint = { sequenceNumber: 341337078, timestamp: '2026-11-03T21:34:37.679Z', digest: 'EM5pMmutamYH6nGgoSrHk2pqsRKofu7Preh29c32BtAW' }

function response(status: number, body: unknown, retryAfter?: string) {
	const headers = new Headers()
	if (retryAfter != null) headers.set('retry-after', retryAfter)
	return new Response(JSON.stringify(body), { status, headers })
}

describe('Tatum GraphQL client', () => {
	test('read posts one GraphQL query and keeps checkpoint time and flat object json', async () => {
		let seen: { url: string; body: any; headers: Record<string, string> } | undefined
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> }
			return response(200, {
				data: {
					checkpoint,
					multiGetObjects: [
						{ address: '0xabc', version: 9, asMoveObject: { contents: { type: { repr: '0x1::m::T' }, json: { current_sqrt_price: '614813437016493683140', is_pause: false, coin_type: '0x2::sui::SUI' } } } },
						null,
					],
				},
			})
		}) as unknown as typeof fetch
		const t = new TatumSui('test-key', 'https://sui-mainnet.gateway.tatum.io/graphql', fetchFn)
		const r = await t.read(['0xabc', '0xdef'])
		expect(seen?.url).toBe('https://sui-mainnet.gateway.tatum.io/graphql')
		expect(seen?.headers['x-api-key']).toBe('test-key')
		expect(seen?.body.jsonrpc).toBeUndefined()
		expect(seen?.body.query).toContain('multiGetObjects')
		expect(seen?.body.variables.ids).toEqual([{ address: '0xabc' }, { address: '0xdef' }])
		expect(r.checkpoint.sequenceNumber).toBe('341337078')
		expect(r.checkpoint.timestampMs).toBe(String(Date.parse(checkpoint.timestamp)))
		expect(r.checkpoint.digest).toBe(checkpoint.digest)
		expect(r.objects[0].data?.content?.fields.current_sqrt_price).toBe('614813437016493683140')
		expect(r.objects[0].data?.content?.fields.coin_type).toBe('0x2::sui::SUI')
		expect(r.objects[1].error).toBeTruthy()
		expect(t.log).toEqual([{ method: 'graphql', ms: expect.any(Number), status: 200 }])
		expect(t.authenticated).toBe(true)
	})

	test('a GraphQL error or an HTTP 404 is a hard failure', async () => {
		const fetchFn = (async () => response(200, { errors: [{ message: 'boom' }] })) as unknown as typeof fetch
		await expect(new TatumSui('', 'https://example.test/graphql', fetchFn).read(['0x1'])).rejects.toThrow('tatum graphql: boom')
		const missing = (async () => response(404, { statusCode: 404, message: 'Not Found' })) as unknown as typeof fetch
		await expect(new TatumSui('', 'https://example.test/graphql', missing).read(['0x1'])).rejects.toThrow('tatum graphql: HTTP 404')
	})

	test('HTTP 429 is retried', async () => {
		let n = 0
		const fetchFn = (async () => {
			n++
			if (n === 1) return response(429, { message: 'slow down' }, '0')
			return response(200, { data: { checkpoint, multiGetObjects: [] } })
		}) as unknown as typeof fetch
		const r = await new TatumSui('', 'https://example.test/graphql', fetchFn).read([])
		expect(n).toBe(2)
		expect(r.checkpoint.sequenceNumber).toBe('341337078')
	})
})
