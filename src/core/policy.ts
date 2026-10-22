// Policy v1: every number the agent, the judge and the learning loops are bound by. Its keccak256 (of canonical JSON)
// goes into every decision record, so changing any of these numbers changes the hash.
// Design rule: memory may tune the SOFT layer (which feeds count, how much each argument weighs, how big the alert
// margin is), and only inside the bounds written here. It never touches the HARD rules (data gates, escalation line).
import { hashCanonical } from './canonical'

export const SOURCES = ['suilend_oracle', 'cetus_usdc_sui', 'tatum_rate', 'coinbase', 'kraken', 'okx', 'coingecko', 'binance'] as const
export type SourceId = (typeof SOURCES)[number]

export const POLICY_V1 = {
	id: 'sentinel-memory/policy/v1',
	description:
		'Duty-of-care policy for watching Suilend obligations on Sui mainnet. Hard data gates and an escalation line come first. After that, bull and bear arguments are weighed against a margin. Memory can adjust feed selection, argument weights and the margin, but only within the bounds below.',
	dataQuality: {
		agreeBps: 50, // a feed "agrees" when it is within 0.50% of the cross-feed median
		maxQuoteAgeSec: 600, // older quotes count as stale
		maxOracleAgeSec: 3600, // Suilend refreshes reserve prices on touch; older than 1h is stale
		minTrustedSources: 3, // need >= 3 trusted, fresh feeds to form a consensus
		maxOracleVsConsensusBps: 300, // protocol oracle vs consensus beyond 3% => ABSTAIN (someone is wrong)
		maxSnapshotLagSec: 900, // observedAt - checkpoint time
	},
	assets: {
		// coin types that move with SUI: their USD value is re-priced at the learned consensus
		suiLinked: [
			'0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
			'83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI',
		],
		// coin types treated as $1 stable for the "market-wide drop" stress (everything else counts as volatile)
		stable: [
			'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
			'375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
			'2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD',
			'41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE',
			'44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI',
			'ce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK',
			'5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
			'c060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
		],
	},
	risk: {
		healthWatchBps: 13000, // unhealthy-borrow-limit / weighted-borrow below 1.30x = bear territory
		escalateHealthBps: 10800, // below 1.08x the owner must act now (hard rule, never learned)
		gapWatchBps: 2500, // volatile collateral can fall < 25% before liquidation = bear territory
		utilizationWatchBps: 9000, // borrowed reserve >= 90% utilized: repaying/withdrawing gets harder, rates spike
		momentumBps: 100, // >= 1% move since the last remembered consensus counts as momentum
	},
	judge: {
		watchMarginPoints: 150, // base margin (bear - bull >= margin => WATCH), adjusted by the regret loop
	},
	memory: {
		// Loop 1: feed reliability. Beta(hits, misses) with exponential forgetting, fixed-point x10000.
		priorHits: 20000, // prior = 2 hits, 1 miss (new feeds start trusted-ish at 67%)
		priorMisses: 10000,
		decayBps: 9600, // each run keeps 96% of the old evidence (~25-run memory)
		muteBelowBps: 5000, // trust < 50% after enough observations => excluded from consensus
		unmuteAboveBps: 6500, // hysteresis: must climb back above 65% to rejoin
		minObservations: 4,
		// Loop 2: argument credibility. Each argument is a forecast checked after `horizonSec`.
		horizonSec: 21600, // 6 hours
		forecastMoveBps: 100, // "risk rose" = drop-to-liquidation shrank, or cover fell, by >= 100 bps
		priceFlatBps: 25, // momentum forecasts: a move under 0.25% is a miss for both sides
		minResolutions: 3,
		multiplierFloorBps: 5000, // a discredited argument still counts at least 0.5x
		multiplierCeilBps: 15000, // a proven argument counts at most 1.5x
		maxPendingRuns: 24, // runs awaiting their horizon (hourly runs and a 6h horizon need about 7)
		// Loop 3: regret. WATCH that changed nothing = false alarm; HOLD before a big drop = miss.
		regretWindow: 24,
		missMoveBps: 300, // HOLD, then risk rose >= 300 bps within the horizon = missed
		regretStepPoints: 10, // +10 margin per net false alarm, -20 per miss (misses cost double)
		marginMinPoints: 80,
		marginMaxPoints: 300,
	},
} as const

export type Policy = typeof POLICY_V1
export const policyHash = (p: Policy = POLICY_V1) => hashCanonical(p)
