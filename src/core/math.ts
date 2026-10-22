export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
export const bpsDiff = (a: number, b: number) => (b === 0 ? 1_000_000 : Math.round(((a - b) * 10000) / b))
export const absBps = (a: number, b: number) => Math.abs(bpsDiff(a, b))
/** Integer median (lower-middle average rounded down) of a non-empty list. */
export function median(xs: number[]): number {
	if (xs.length === 0) throw new Error('median of empty list')
	const s = [...xs].sort((a, b) => a - b)
	const mid = s.length >> 1
	return s.length % 2 ? s[mid] : Math.floor((s[mid - 1] + s[mid]) / 2)
}
export const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`
export const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`
export const usdK = (micros: number) => `$${Math.round(micros / 1e6).toLocaleString('en-US')}`
