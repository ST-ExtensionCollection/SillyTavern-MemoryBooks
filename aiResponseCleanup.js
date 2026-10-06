// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

// Harmony control tokens. At least one pipe is required so ordinary
// angle-bracket words in memory text (e.g. "<end>") are never stripped.
const HARMONY_TOKEN = '(?:<\\|(?:start|end|return|constrain|message|channel)\\|?>|<(?:start|end|return|constrain|message|channel)\\|>)';
const HARMONY_CHANNEL = '(?:<\\|channel\\|?>|<channel\\|>)';
const HARMONY_MESSAGE = '(?:<\\|message\\|?>|<message\\|>)';

/**
 * Strip reasoning and channel noise that precedes or wraps the JSON payload:
 * - SillyTavern's configured reasoning template (strict: only a leading block);
 * - harmony markup: <|channel|>analysis<|message|>, <|start|>, <|end|>, and the
 *   malformed <|channel>thought<channel|> variant some instruct templates emit;
 * - <think>/<thinking> blocks and stray think/thought/reasoning/analysis tags.
 * When a harmony `final` channel is present, only the text after it is kept.
 * @param {string} input
 * @param {Function|null} [parseReasoning] - context.parseReasoningFromString
 * @returns {string}
 */
export function stripReasoningNoise(input, parseReasoning = null) {
    let t = String(input);

    // Accept the template parse only when it removed a non-empty reasoning
    // block and left JSON-looking content.
    try {
        if (typeof parseReasoning === 'function') {
            const r = parseReasoning(t, { strict: true });
            if (r && typeof r.content === 'string' && r.content.trim()
                && typeof r.reasoning === 'string' && r.reasoning.trim()
                && /[{[]/.test(r.content)) {
                t = r.content;
            }
        }
    } catch {
        // Non-fatal: fall through to regex cleanup
    }

    const finalMarker = t.match(new RegExp(`${HARMONY_CHANNEL}\\s*final\\b[\\s\\S]{0,40}?${HARMONY_MESSAGE}`, 'i'));
    if (finalMarker) {
        t = t.slice(finalMarker.index + finalMarker[0].length);
    }

    return t
        // Channel header with its name: <|channel|>analysis<|message|>
        .replace(new RegExp(`${HARMONY_CHANNEL}[\\s\\S]*?${HARMONY_MESSAGE}`, 'gi'), '')
        // Unterminated channel header: <|channel>thought
        .replace(new RegExp(`${HARMONY_CHANNEL}\\s*\\w+`, 'gi'), '')
        .replace(new RegExp(HARMONY_TOKEN, 'gi'), '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<\/?(?:think|thinking|thought|reasoning|analysis)>/gi, '')
        .trim();
}

function unescapeJsonString(s) {
    try {
        return JSON.parse(`"${s}"`);
    } catch {
        return String(s)
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}

function grabJsonString(text, key) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
    return m ? m[1] : null;
}

/**
 * Last-resort recovery of memory fields from text that failed structured
 * parsing. Requires a well-formed title string, a well-formed content string
 * (content/summary/memory_content) and a closed keywords array, so a response
 * truncated mid-keywords still fails as truncated instead of saving a Memory
 * with no keywords.
 * @param {string[]} texts - Candidates, most specific first
 * @returns {{title: string, content: string, keywords: string[]}|null}
 */
export function recoverMemoryFields(texts) {
    for (const text of texts) {
        if (typeof text !== 'string' || !text) continue;
        const rawContent = grabJsonString(text, 'content')
            || grabJsonString(text, 'summary')
            || grabJsonString(text, 'memory_content');
        const rawTitle = grabJsonString(text, 'title');
        const kwBlock = text.match(/"keywords"\s*:\s*\[([^\]]*)\]/i);
        if (!rawContent || !rawTitle || !kwBlock) continue;
        const keywords = (kwBlock[1].match(/"((?:[^"\\]|\\.)*)"/g) || [])
            .map(s => unescapeJsonString(s.slice(1, -1)).trim())
            .filter(Boolean);
        return {
            title: unescapeJsonString(rawTitle),
            content: unescapeJsonString(rawContent),
            keywords,
        };
    }
    return null;
}
