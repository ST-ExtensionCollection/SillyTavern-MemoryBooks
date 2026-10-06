// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

// Harmony control tokens. At least one pipe is required so ordinary
// angle-bracket words in memory text (e.g. "<end>") are never stripped.
const HARMONY_TOKEN = '(?:<\\|(?:start|end|return|constrain|message|channel)\\|?>|<(?:start|end|return|constrain|message|channel)\\|>)';
const HARMONY_CHANNEL = '(?:<\\|channel\\|?>|<channel\\|>)';
const HARMONY_MESSAGE = '(?:<\\|message\\|?>|<message\\|>)';
const HARMONY_END = '(?:<\\|end\\|?>|<end\\|>)';

const HARMONY_FINAL_RE = new RegExp(`${HARMONY_CHANNEL}\\s*final\\b[\\s\\S]{0,40}?${HARMONY_MESSAGE}`, 'i');
// Analysis/commentary body, only when an explicit end token closes it
const HARMONY_REASONING_BODY_RE = new RegExp(`${HARMONY_CHANNEL}\\s*(?:analysis|commentary)\\b[\\s\\S]{0,40}?${HARMONY_MESSAGE}[\\s\\S]*?${HARMONY_END}`, 'gi');
const HARMONY_HEADER_RE = new RegExp(`${HARMONY_CHANNEL}[\\s\\S]*?${HARMONY_MESSAGE}`, 'gi');
const HARMONY_BARE_CHANNEL_RE = new RegExp(`${HARMONY_CHANNEL}\\s*\\w+`, 'gi');
const HARMONY_TOKEN_RE = new RegExp(HARMONY_TOKEN, 'gi');
const LEADING_REASONING_RE = /^\s*(?:<(thinking|thought|reasoning|analysis)>[\s\S]*?<\/\1>\s*)+/i;
const STRAY_REASONING_TAG_RE = /<\/?(?:think|thinking|thought|reasoning|analysis)>/gi;
const JSON_OBJECT_START_RE = /\{\s*["']/;

/**
 * Strip reasoning and channel noise that precedes or wraps the JSON payload:
 * - SillyTavern's configured reasoning template (strict: only a leading block);
 * - harmony markup: <|channel|>analysis<|message|>, <|start|>, <|end|>, and the
 *   malformed <|channel>thought<channel|> variant some instruct templates emit;
 *   an analysis/commentary body is removed when <|end|> closes it;
 * - <think> blocks anywhere; leading <thinking>/<thought>/<reasoning>/<analysis>
 *   blocks; stray reasoning tags before the JSON object. Tags inside the JSON
 *   are left alone so memory text that mentions them survives.
 * When a harmony `final` channel is present, only the text after it is kept.
 * @param {string} input
 * @param {Function|null} [parseReasoning] - context.parseReasoningFromString
 * @returns {string}
 */
export function stripReasoningNoise(input, parseReasoning = null) {
    let t = String(input);

    // Accept the template parse only when it removed a non-empty reasoning
    // block and left a JSON object.
    try {
        if (typeof parseReasoning === 'function') {
            const r = parseReasoning(t, { strict: true });
            if (r && typeof r.content === 'string' && r.content.trim()
                && typeof r.reasoning === 'string' && r.reasoning.trim()
                && JSON_OBJECT_START_RE.test(r.content)) {
                t = r.content;
            }
        }
    } catch {
        // Non-fatal: fall through to regex cleanup
    }

    const finalMarker = t.match(HARMONY_FINAL_RE);
    if (finalMarker) {
        t = t.slice(finalMarker.index + finalMarker[0].length);
    }

    t = t
        .replace(HARMONY_REASONING_BODY_RE, '')
        // Channel header with its name: <|channel|>analysis<|message|>
        .replace(HARMONY_HEADER_RE, '')
        // Unterminated channel header: <|channel>thought
        .replace(HARMONY_BARE_CHANNEL_RE, '')
        .replace(HARMONY_TOKEN_RE, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(LEADING_REASONING_RE, '');

    const jsonStart = t.search(JSON_OBJECT_START_RE);
    if (jsonStart === -1) return t.replace(STRAY_REASONING_TAG_RE, '').trim();
    return (t.slice(0, jsonStart).replace(STRAY_REASONING_TAG_RE, '') + t.slice(jsonStart)).trim();
}

/**
 * Whether a Memory saved with this activation mode needs keywords to activate.
 * - Constant (blue) entries always activate.
 * - Vector Storage, when enabled for World Info, activates vectorized (link,
 *   the default) entries by content similarity, and every entry when "all
 *   entries" is on. SillyTavern still keyword-scans vectorized entries, so
 *   without Vector Storage they rely on keywords like Normal (green) entries.
 * @param {string} [constVectMode] - 'link' | 'green' | 'blue' (default 'link')
 * @param {object} [extensionSettings] - SillyTavern extension_settings
 * @returns {boolean}
 */
export function memoryKeywordsRequired(constVectMode, extensionSettings = {}) {
    const mode = String(constVectMode ?? '').trim().toLowerCase();
    if (mode === 'blue') return false;
    const vectors = extensionSettings?.vectors;
    const vectorsDisabled = Array.isArray(extensionSettings?.disabledExtensions)
        && extensionSettings.disabledExtensions.includes('vectors');
    if (vectorsDisabled || vectors?.enabled_world_info !== true) return true;
    return mode === 'green' && vectors.enabled_for_all !== true;
}

/**
 * Keywords worth saving: non-blank strings, trimmed.
 * @param {*} keywords
 * @returns {string[]}
 */
export function usableKeywords(keywords) {
    return Array.isArray(keywords)
        ? keywords.filter(k => typeof k === 'string' && k.trim() !== '').map(k => k.trim())
        : [];
}

const CONTROL_CHAR_RE = /[\u0000-\u001F]/g;

function spaceControlChars(text) {
    return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHAR_RE, ' ');
}

// One string-aware pass (same rules as extractBalancedJson): inside a string,
// a line break becomes the escape \n and a tab \t; other control characters
// are dropped. Outside strings they become spaces. Returns null when the scan
// ends inside a string: an unescaped quote shifted it, so text between fields
// may have been treated as string content.
function escapeLineBreaksInStrings(text) {
    const s = text.replace(/\r\n?/g, '\n');
    let out = '';
    let inString = false;
    let escaping = false;
    for (const ch of s) {
        const isControl = ch.charCodeAt(0) < 0x20;
        if (!inString) {
            if (ch === '"') inString = true;
            out += isControl ? ' ' : ch;
        } else if (escaping) {
            escaping = false;
            out += isControl ? (ch === '\t' ? 't' : 'n') : ch;
        } else if (ch === '\\') {
            escaping = true;
            out += ch;
        } else if (ch === '"') {
            inString = false;
            out += ch;
        } else if (isControl) {
            out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : '';
        } else {
            out += ch;
        }
    }
    return inString ? null : out;
}

/**
 * Texts to parse for a response whose JSON may hold raw line breaks, most
 * faithful first (setting "Line breaks in AI JSON"):
 * - 'off': unchanged; normalization then deletes control characters (legacy,
 *   which glues words across line breaks);
 * - 'space': control characters become spaces;
 * - 'detect' (default): line breaks inside JSON strings are kept as \n escapes
 *   and others become spaces, then the 'space' text as a fallback. Strings are
 *   tracked only from the first '{' to the last '}', so quotes in surrounding
 *   prose do not matter. When an unescaped quote inside that span throws the
 *   string detection off, only the 'space' text.
 * @param {string} text
 * @param {'off'|'space'|'detect'} [mode]
 * @returns {string[]}
 */
export function lineBreakVariants(text, mode = 'detect') {
    const value = String(text ?? '');
    if (mode === 'off') return [value];
    const spaced = spaceControlChars(value);
    if (mode === 'space') return [spaced];
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    const body = start !== -1 && end > start ? escapeLineBreaksInStrings(value.slice(start, end + 1)) : null;
    const escaped = body === null
        ? null
        : spaceControlChars(value.slice(0, start)) + body + spaceControlChars(value.slice(end + 1));
    return escaped === null || escaped === spaced ? [spaced] : [escaped, spaced];
}

const JSON_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// Single pass, so "\\n" stays a backslash + "n"; an unknown escape such as
// \' yields the character itself.
function unescapeJsonString(s) {
    return String(s).replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (m, e) => (
        e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (JSON_ESCAPES[e] ?? e)
    ));
}

// A quote ends the value only when the next key (an identifier-like name) or
// the object's closing brace follows (end of text, a fence, or an enclosing
// bracket; line breaks are spaces by now, see lineBreakVariants), so
// unescaped quotes in dialogue stay in the value.
// A truncated value has no terminator and does not match.
const STRUCTURAL_QUOTE_END = '\\s*(?:,\\s*"[A-Za-z_][\\w-]{0,39}"\\s*:|\\}\\s*(?:$|```|[}\\]]))';
const FIELD_RE = Object.fromEntries(['title', 'content', 'summary', 'memory_content', 'keywords'].map(key => [
    key,
    new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.|"(?!${STRUCTURAL_QUOTE_END}))*)"(?=${STRUCTURAL_QUOTE_END})`, 'i'),
]));
const TITLE_KEY_RE = /"title"\s*:/gi;
// Strings are skipped whole, so a keyword may contain "]". An array cut off by
// truncation still matches; its complete strings are kept.
const KEYWORDS_ARRAY_RE = /"keywords"\s*:\s*\[((?:"(?:[^"\\]|\\.)*"|[^\]"])*)/i;
const CONTENT_KEYS = ['content', 'summary', 'memory_content'];
const KEY_PRESENT_RE = Object.fromEntries(CONTENT_KEYS.map(key => [key, new RegExp(`"${key}"\\s*:`, 'i')]));

function grabJsonString(text, key) {
    const m = text.match(FIELD_RE[key]);
    return m ? m[1] : null;
}

/**
 * Last-resort recovery of memory fields from text that failed structured
 * parsing. Requires exactly one title key (more means drafts are mixed in),
 * a well-formed title string and a well-formed content string
 * (the first of content/summary/memory_content present); a value cut off by
 * truncation never matches, and no other content key is used in its place.
 * Keywords never block recovery: every complete string in the keywords array
 * is kept (an array cut off by truncation yields the keywords before the cut),
 * a comma-separated keywords string is split, and a missing field yields none.
 * Callers should have the user review a recovered memory.
 * @param {string[]} texts - Candidates, most specific first
 * @returns {{title: string, content: string, keywords: string[]}|null}
 */
export function recoverMemoryFields(texts) {
    for (const text of texts) {
        if (typeof text !== 'string' || !text) continue;
        if ((text.match(TITLE_KEY_RE) || []).length !== 1) continue;
        // Use the first content key present; if its value was cut off, do not
        // fall back to a complete summary instead.
        const contentKey = CONTENT_KEYS.find(key => KEY_PRESENT_RE[key].test(text));
        const rawContent = contentKey ? grabJsonString(text, contentKey) : null;
        const rawTitle = grabJsonString(text, 'title');
        if (!rawContent || !rawTitle) continue;
        const kwBlock = text.match(KEYWORDS_ARRAY_RE);
        const kwString = kwBlock ? null : grabJsonString(text, 'keywords');
        const keywords = (kwBlock
            ? (kwBlock[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map(s => unescapeJsonString(s.slice(1, -1)))
            : (kwString ? unescapeJsonString(kwString).split(',') : []))
            .map(k => k.trim())
            .filter(Boolean);
        return {
            title: unescapeJsonString(rawTitle),
            content: unescapeJsonString(rawContent),
            keywords,
        };
    }
    return null;
}
