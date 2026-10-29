/**
 * Whether `value` is a safe same-origin path for a `Location` header. The
 * value starts with one `/`, the next character is not `/` or `\`, and each
 * character is printable ASCII (0x20 to 0x7E).
 *
 * The check stops these attacks:
 *
 * - An open redirect: `//evil.com`, `/\evil.com`, and `https://evil.com` go to
 *   another host. A browser reads `/\` as `//`.
 * - A scheme that does not navigate, such as `javascript:` or `data:`.
 * - A control character, such as CR or LF, that splits the response.
 *
 * Why strict: a short allow list is easy to audit. The check rejects some safe
 * values, such as a path with raw UTF-8. Percent-encode the path first.
 *
 * Ported from the ngrok frontend `isSafeLocalPath`, with its test cases.
 *
 * @example
 * isSafeLocalPath("/components/button?tab=props"); // => true
 * isSafeLocalPath("//evil.com/foo"); // => false
 * isSafeLocalPath("/café"); // => false
 */
export function isSafeLocalPath(value: string): boolean {
	return /^\/(?![/\\])/u.test(value) && !/[^\u0020-\u007E]/u.test(value);
}
