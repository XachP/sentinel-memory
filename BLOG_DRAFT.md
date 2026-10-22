<!-- DRAFT: needs Zachary's OK before publishing (dev.to / Medium / Hashnode). Replace every {{…}} with real numbers from docs/data/scorecard.json on the day you publish. -->
# My loan guardian learned to stop crying wolf, and kept its nerve when it mattered

*Sentinel Memory: a deterministic agent for Suilend loans that uses Walrus Memory for what it learns and Tatum for what it sees. Built for Total Recall (Tatum × Walrus Foundation).*

## The problem: monitoring agents forget

Most "AI agents" that watch a DeFi position start from scratch every run. They re-trust the same flaky price API, raise the same alarm about the same slightly-tight loan every hour, and never notice that half their alerts were noise. People mute alerts like that. Then they miss the one that mattered.

I wanted the opposite: an agent whose **memory changes what it does**, in ways I can audit, and with limits I set in advance.

## What Sentinel Memory does

Every hour it watches a few real Suilend loans on Sui mainnet. For each one it computes the *cover* (Suilend's unhealthy-borrow limit divided by the weighted borrow; 1.00x means liquidation) and the *drop-to-liquidation*. Then a bull agent and a bear agent argue, and a fixed rule list decides:
- **HOLD**, **WATCH** or **ESCALATE**;
- **ABSTAIN** when the data is not good enough to act on.

There is no LLM in the decision path. Every decision is replayable bit for bit, in your browser, from published evidence.

## How it uses Tatum

All chain reads go through **Tatum's Sui RPC gateway**. One `sui_multiGetObjects` call returns:
- the Suilend main lending market (all 45 reserves: prices, cToken supply, cumulative borrow rates, LTVs);
- every watched obligation;
- a Cetus USDC/SUI pool.

From those it re-derives each loan the way Suilend's liquidation check does. My test fixtures are real Tatum responses, and the re-derived debt matches Suilend's stored value to within 0.5%. The Cetus pool's `sqrt_price` gives an on-chain DEX price, and the Suilend reserve gives the protocol's own oracle price. Tatum's Data API adds an aggregator price. A whole run is three Tatum requests.

## How it uses Walrus Memory

Each run writes three kinds of memory to Walrus Memory on mainnet:

- a **state snapshot**: feed trust, argument credibility, the alert margin and the claims waiting to be checked. It is hash-chained to the previous snapshot.
- a **decision record**: the evidence hash, the policy hash, the recalled blob IDs, the decision *with* memory and the decision *with empty memory* on the same evidence, and a plain-English list of what memory changed.
- **lessons**: "price feed binance is now MUTED", "checked 18 matured forecasts, 15 right: R1_near_liquidation 0/4…".

The next run starts by recalling the newest intact snapshot. If the hash doesn't match, the snapshot is rejected. That recall is the only way anything learned reaches the decision.

## Three things it learns

1. **Which feeds to trust.** Each feed is graded against the trust-blind median of all fresh feeds. A feed that keeps disagreeing, goes stale or errors drops below 50% trust and is excluded from the consensus. To rejoin it must climb back above 65%. *In the live run: {{e.g. binance muted after 4 runs because it is geo-blocked from US runners; suilend_oracle trust {{x}}% because its price only refreshes when the reserve is touched}}.*
2. **Which of its own arguments are right.** Every argument is a forecast. "Cover is above the watch line" predicts that risk won't rise by 100 bps in six hours. "SUI is down 1% since the last price I remember" predicts a further fall. Six hours later the agent checks each forecast against the chain. An argument's weight drifts between 0.5x and 1.5x with its hit rate. *Live: {{R1_near_liquidation was right {{a}}/{{b}} times, so it now counts ×{{m}}}}.*
3. **Regret.** A WATCH that changed nothing is a false alarm, and it raises the alert margin. A HOLD followed by a ≥3-point jump in risk is a **miss**, and it lowers the margin twice as hard. *Live: margin went {{150 → x}}.*

## How it learned over time (the measured part)

The scorecard replays every saved run twice on the same evidence: once with memory chained the way the agent ran, once with memory wiped each run.

| | With memory | Empty memory |
|---|---|---|
| alerts | {{}} | {{}} |
| false alarms | {{}} | {{}} |
| misses | {{}} | {{}} |
| decisions re-weighted by memory | {{}} | n/a |
| actions changed by memory | {{}} | n/a |

{{One paragraph on a specific run: "Run #N, Nov X: the sSUI/SUI loop sat at 1.09x cover. On day 1 the bear won by 50 points; by day 5 R1 had been wrong 30 times in a row (the loop is price-neutral, so its cover only erodes with interest), the margin was 190, and the agent HOLDs, while still ESCALATE-ing the moment cover crosses 1.08x."}}

## The guardrails memory can't cross

- **Hard rules are not learnable.** The data gates and the 1.08x escalation line are written in the policy, and its hash goes into every record.
- **Novelty guard.** If a loan's risk jumped ≥300 bps since the reading memory holds for it, learned dampening is suspended for that loan. *Memory may make the agent calmer about the familiar, never about the new.* A test covers it: after 30 calm runs taught the agent to ignore a tight loan, a sudden 7% drop still raises WATCH.
- **No memory, no overwrite.** If Walrus is unreachable, the agent still decides (hard rules need no memory). It does not write, so it can't fork its own history.

## Try it

- Dashboard: {{https://…github.io/sentinel-memory}}. Click "Re-derive the latest decision in my browser".
- Code: {{https://github.com/XachP/sentinel-memory}}

Built with @Tatum_io and @WalrusFoundation for #TotalRecall.
