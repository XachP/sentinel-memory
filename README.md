# Sentinel Memory

**A guardian for real Suilend loans on Sui mainnet that remembers which price feeds lied, which of its own arguments were right, and which of its alarms were false. Tomorrow's decision is visibly different because of yesterday's memory, and every decision cites the Walrus blobs it was conditioned on.**

Built for **Total Recall** (Tatum × Walrus Foundation, Oct 20 – Nov 10, 2026) · Track 2: Smart Agents for Real Life.

- **Dashboard:** `https://<user>.github.io/sentinel-memory/` (GitHub Pages from `docs/`)
- **Live data:** `docs/data/runs/*.json`. Each run holds the full evidence, the recalled memory, the decision and the new memory, with hashes.
- **Memory:** Walrus Memory on mainnet (`relayer.memory.walrus.xyz`), namespaces `sentinel-memory.state`, `.decisions`, `.lessons`. Agent (delegate) public key / `MEMWAL_AGENT_ID`: `1e80216547306fd1ef57d64746dcca95718c198e5e78490a966db2a8e2932677`
- **Chain data:** Tatum Sui RPC (`sui-mainnet.gateway.tatum.io`) for the Suilend market, the watched obligations, the Cetus pool and checkpoints

## What it does

Every hour (GitHub Actions cron, with a stand-by runner that only acts if no run happened in the last 75 minutes) the agent runs one cycle:

1. **Recall.** It loads the newest intact *state snapshot* from Walrus Memory. The hash is checked, and a tampered or truncated recall is rejected.
2. **Read the chain through Tatum.** Three requests: checkpoint, checkpoint time, and one `sui_multiGetObjects` covering the Suilend main market, every watched obligation and a Cetus USDC/SUI pool. From these it re-derives each loan exactly as Suilend's liquidation check does: cToken exchange rates, cumulative borrow rates, close-LTV and borrow weights.
3. **Price SUI from the feeds memory still trusts.** There are 8 feeds: the Suilend oracle and Cetus on-chain (via Tatum), the Tatum Data API, Coinbase, Kraken, OKX, CoinGecko and Binance.
4. **Argue and judge.** A bull agent and a bear agent argue from the same evidence. The judge, a fixed and ordered rule list reused from Lifeline Sentinel, our earlier duty-of-care agent, picks the first matching rule:
   - data gates, which produce **ABSTAIN**;
   - the hard escalation line (cover < 1.08x), which produces **ESCALATE**;
   - bear − bull ≥ margin, which produces **WATCH**;
   - otherwise **HOLD**.
5. **Decide twice.** It decides once with memory and once with empty memory, on the same evidence. The difference is the measured effect of memory, and it is written into the record.
6. **Remember.** It writes a new state snapshot (hash-chained to the previous one), a decision record and short human-readable lessons.

## The three learning loops

| Loop | What is remembered | How it changes the next decision | Bounds |
|---|---|---|---|
| **1. Feed reliability** | Per feed: Beta(hits, misses) with exponential forgetting. A hit = fresh and within 0.5% of the trust-blind median of all fresh feeds | Feeds under 50% trust (after ≥ 4 observations) are **excluded from the consensus**. They must climb back above 65% to rejoin | Hysteresis; the reference is trust-blind, so a feed can earn its way back |
| **2. Argument credibility** | Each argument is a forecast. Bull: "risk won't rise ≥ 100 bps in 6h". Bear: "it will". Momentum arguments: "price up/down". Checked against the chain 6h later | Argument points × credibility multiplier | 0.5x … 1.5x, and only after ≥ 3 checks |
| **3. Regret** | WATCH → justified or false alarm. HOLD → fine or **missed** (risk rose ≥ 300 bps) | Alert margin = 150 + 10 × (false alarms − justified) − 20 × misses | 80 … 300 points |

**Guardrails memory cannot cross:**
- Memory never touches the hard rules (data gates, the escalation line).
- **Novelty guard:** if a loan's risk jumped ≥ 300 bps since the reading memory holds for it, learned dampening is suspended for that loan. Memory can make the agent calmer about the familiar, never about the new.
- If Walrus is unreachable, the agent still decides, since hard rules need no memory. It does **not** overwrite memory, and the run exits non-zero.

## How memory is written and read

- **Write.** The default path is the relayer's standard `remember`: the relayer embeds, SEAL-encrypts and uploads to Walrus.
  - If that fails, the agent switches per item to **manual mode**: it SEAL-encrypts locally (Mysten SEAL key servers) and sends its own deterministic 1536-d feature-hash embedding. The relayer still uploads the ciphertext to Walrus and pays for it.
  - This is not hypothetical. On Oct 22, 2026 the relayer reported `writes: degraded`, and every standard write failed with `Embedding API error (401)`. The fallback kept the agent writing to mainnet anyway. Each run file records which path was used (`memoryNotes`).
- **Read.** Reading needs no embeddings:
  - list the account's memories (metadata);
  - take the newest blobs in `sentinel-memory.state`;
  - download them from the public Walrus aggregator;
  - SEAL-decrypt them with a session key signed by the delegate key (a personal message, so no gas);
  - keep the newest snapshot whose hash checks out.

## Run it

```bash
bun install
bun test                          # 32 tests: position math on real mainnet fixtures, the 3 loops, A/B, replay
bun src/cli.ts run --memory local # one real cycle against Sui mainnet via Tatum, memory in a local file
bun src/cli.ts run                # the real thing: Walrus Memory mainnet (needs MEMWAL_* env)
bun src/cli.ts replay docs/data/runs/00012.json   # re-derive a past decision bit for bit
bun src/cli.ts ab                 # replay all saved runs with chained vs empty memory -> docs/data/scorecard.json
bun scripts/smoke-memwal.ts       # health -> remember -> list -> download + decrypt; prints MEMWAL_AGENT_ID
```

Environment: see `.env.example`.
- Without `TATUM_API_KEY`, the Tatum gateway's anonymous plan (5 req/min) still covers a run, but the Tatum Data API feed is skipped. A keyed feed with no key is left out, not graded as an error.
- To guard your own loan, set `WATCH_OBLIGATIONS=0x…:label`.

## Verify it

- **Dashboard → "Re-derive the latest decision in my browser"** runs the same core (`docs/sentinel-core.js`, built from `src/core`) on the published evidence and recalled state. It checks that `reasoningHash` and `nextStateHash` match.
- **"Read Sui mainnet via Tatum now"** calls Tatum's gateway from your browser.
- Every recalled and written blob id links to Walruscan. The memories are Seal-encrypted, so the plaintext of each one is published next to it in `docs/data/runs/`.

## Honest notes

- The watched obligations (`config/watch.json`) are **public Suilend loans we do not own**. The agent is read-only: it never signs a transaction. ESCALATE means "the owner should repay or add collateral now".
- Learning is only visible when the world gives it something to learn. Binance is geo-blocked from US runners, and Suilend oracle prices go stale between refreshes. Real feed-level lessons arrive within hours; argument and alarm lessons arrive 6h after each run. Synthetic scenarios exist **only in `test/`** and in `scripts/preview-data.ts` (dashboard layout preview, never published).
- The Tatum Data API's SUI rate is sourced from CoinGecko, so those two feeds are not independent. The trust-blind median limits the damage.

## Layout

```
src/core      pure, deterministic: policy, evidence, position math, agents, judge, learning loops, step, scorecard
src/sources   Tatum Sui RPC client, Suilend parser, Cetus + off-chain feeds, evidence collector
src/memory    Walrus Memory store (MemWal SDK), local store, memory record format
docs/         GitHub Pages dashboard + published run data
test/         bun tests (fixtures are real mainnet RPC responses fetched through Tatum on Oct 22, 2026)
```

MIT licensed.
