/** Why: `setTimeout` turns a longer delay into 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Throws for a value that is not an integer from 0 to `max`, so a bad option stops startup.
 *
 * @example
 * checkCount("shutdownDeadlineMs", 10_000, MAX_TIMER_MS);
 */
export function checkCount(name: string, value: number, max = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		const range = max === Number.MAX_SAFE_INTEGER ? "of 0 or more" : `from 0 to ${max}`;
		throw new Error(`${name} must be an integer ${range}, not ${value}.`);
	}
}
