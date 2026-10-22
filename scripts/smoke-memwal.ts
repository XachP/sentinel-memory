// End-to-end check of the Walrus Memory mainnet credentials: health -> remember -> list -> recall (decrypt).
// Prints the delegate public key (the form's MEMWAL_AGENT_ID) and blob ids, never the private key.
// Needs MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID (e.g. `source scripts/live-env.sh`).
import { WalrusStore } from '../src/memory/walrus'

const NS = 'sentinel-memory.smoke'
const store = new WalrusStore()
const mw = store.client()
console.log('MEMWAL_AGENT_ID (delegate public key):', await mw.getPublicKeyHex())
const h: any = await mw.health()
console.log('relayer health:', h.status, 'writes:', h.writes, 'write_ready:', h.write_ready)
const text = `Sentinel Memory smoke test at ${new Date().toISOString()}: the delegate key can write to Walrus Memory on mainnet.`
const [w] = await store.rememberAll([{ namespace: NS, kind: 'lesson', seq: 0, text }])
for (const l of store.log) console.log('note:', l)
console.log('remembered blob_id:', w.blobId)
const back = await store.recall('smoke', NS, 3)
console.log('recalled (decrypted):', back.map((x) => `${x.blobId} ${x.createdAt} "${x.text.slice(0, 70)}"`))
console.log(back.some((x) => x.text === text) ? 'SMOKE OK: round trip verified' : 'SMOKE: write ok, newest recall did not include it yet')
