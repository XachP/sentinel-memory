<!-- DRAFT 2:30 script. Screen recording of the dashboard + terminal; voice-over by Zachary (or captions only). -->
# Sentinel Memory: video script (≈2:30)

**0:00–0:15 · Hook** (dashboard header on screen)
"Most monitoring agents forget everything between runs. They trust the same broken price feed and raise the same useless alarm every hour. Sentinel Memory guards real Suilend loans on Sui mainnet, and it remembers."

**0:15–0:40 · What it sees: Tatum** (terminal: `bun src/cli.ts run`, then highlight the 3 Tatum calls)
"Every hour it reads Sui mainnet through Tatum's RPC gateway: the Suilend market, each loan and a Cetus pool, all in one multiGetObjects call. It re-derives each loan the way Suilend's liquidation check does. Then it prices SUI from eight feeds, both on-chain and off-chain."

**0:40–1:10 · What it remembers: Walrus** (dashboard: "Today: with memory vs empty memory")
"Before deciding, it recalls its last state snapshot from Walrus Memory. That snapshot holds which feeds to trust, how often each of its own arguments was right, and how many of its alarms were false. Then it decides twice on the same evidence, once with memory and once without. This box shows exactly what memory changed, and the blob it was conditioned on." (click a Walruscan link)

**1:10–1:40 · The three loops** (feed-trust chart, argument table, margin chart)
"Loop one: Binance is geo-blocked from our runner, so it got muted. Loop two: every argument is a forecast checked six hours later. This bear argument was wrong {{n}} times, so it now counts for half. Loop three: false alarms raise the bar, and misses lower it twice as hard."

**1:40–2:05 · The guardrails** (README guardrails section, or a test run of the novelty-guard test)
"Memory can make it calmer about the familiar, never about the new. If risk jumps, the learned dampening switches off. The hard escalation line is never learned, and if Walrus is down it still decides but won't overwrite its memory."

**2:05–2:25 · Proof** (scorecard, then click "Re-derive the latest decision in my browser" → MATCH)
"The scorecard replays every run with and without memory: {{x}} false alarms instead of {{y}}, with {{z}} misses. And you don't have to trust me: your browser re-runs the decision from published evidence, and the hashes match."

**2:25–2:30 · Close**
"Sentinel Memory. Tatum for what it sees, Walrus for what it learned."
