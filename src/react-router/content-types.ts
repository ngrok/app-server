/**
 * The content types of React Router's files that `mime` does not know, by
 * file extension. Why one constant: the server sends a file with this type,
 * and the build writes the compressed copies of a file by this type, so the
 * two must agree.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = { ".data": "text/x-script" };
