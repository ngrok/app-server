/**
 * A `Vary` value with `name` added, or `undefined` when `vary` already covers
 * it. The existing values stay as they are.
 *
 * @example
 * withVary("Accept", "Accept-Encoding"); // => "Accept, Accept-Encoding"
 * withVary("accept-encoding", "Accept-Encoding"); // => undefined
 */
export function withVary(vary: string | null, name: string): string | undefined {
	if (vary == null || vary.trim() === "") {
		return name;
	}
	const lower = name.toLowerCase();
	for (const part of vary.split(",")) {
		const value = part.trim().toLowerCase();
		if (value === lower || value === "*") {
			return undefined;
		}
	}
	return `${vary}, ${name}`;
}
