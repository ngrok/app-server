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
	const values = new Set(vary.split(",").map((value) => value.trim().toLowerCase()));
	return values.has(name.toLowerCase()) || values.has("*") ? undefined : `${vary}, ${name}`;
}
