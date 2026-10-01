/**
 * internal.ts — small helpers shared by the three modules. Not part of the
 * public API: `package.json` `exports` does not expose this file and no
 * module re-exports it.
 */
/**
 * A plain object or a null-prototype object: not an array, Map, Set, Date,
 * RegExp, function or class instance. A record made in another realm
 * (`node:vm`, an iframe) counts as plain, because its prototype is that
 * realm's `Object.prototype`, whose own prototype is `null`.
 */
export function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
}
// Control characters (Cc), format characters such as the bidi controls
// U+061C, U+200E/F, U+202A-202E and U+2066-2069 (Cf), line and paragraph
// separators (Zl, Zp) and lone surrogates (Cs). None of these should reach a
// terminal or a log line from a caller-supplied string.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
/**
 * Make a caller-supplied string safe to put in a sentence: newlines, tabs and
 * carriage returns become `\n`, `\t` and `\r`, and every other control, bidi
 * or format character becomes `\u{HEX}`. Ordinary text and non-ASCII letters
 * are left alone, so the output cannot start a new line, reorder the text
 * around it or send a terminal escape.
 */
export function escapeText(text) {
    return text.replace(UNSAFE_TEXT, (ch) => {
        if (ch === '\n')
            return '\\n';
        if (ch === '\r')
            return '\\r';
        if (ch === '\t')
            return '\\t';
        return `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`;
    });
}
const MAX_SHOWN = 80;
/**
 * Render a received value for an error message without ever throwing and
 * without calling into the value. Strings are quoted, escaped and cut at 80
 * characters; numbers, booleans, null and undefined print as themselves;
 * bigint prints as `1n`; everything else is named by kind. Never calls
 * `toString`, `toJSON` or a getter, so a hostile value cannot change or break
 * the error that reports it.
 */
export function describe(value) {
    if (typeof value === 'string') {
        const cut = value.length > MAX_SHOWN;
        return escapeText(JSON.stringify(cut ? value.slice(0, MAX_SHOWN) : value)) + (cut ? '…' : '');
    }
    if (typeof value === 'bigint')
        return `${value}n`;
    if (typeof value === 'symbol')
        return 'a symbol';
    if (typeof value === 'function')
        return 'a function';
    if (typeof value === 'object' && value !== null) {
        try {
            return Array.isArray(value) ? 'an array' : 'an object';
        }
        catch {
            return 'an object'; // a revoked proxy makes Array.isArray throw
        }
    }
    return String(value);
}
/**
 * Whether `text` shows nothing: empty, or only whitespace and
 * Default_Ignorable_Code_Point characters (zero-width spaces, bidi controls,
 * the soft hyphen, variation selectors, Hangul fillers and similar).
 * `String.prototype.trim` alone misses the ignorable ones.
 */
export function isBlank(text) {
    return /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*$/u.test(text);
}
