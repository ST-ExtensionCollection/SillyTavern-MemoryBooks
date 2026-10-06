// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { lineBreakVariants, memoryKeywordsRequired, recoverMemoryFields, stripReasoningNoise, usableKeywords } from './aiResponseCleanup.js';

const JSON_PAYLOAD = '{"title":"T","content":"C","keywords":["k"]}';

test('removes think blocks', () => {
    assert.equal(stripReasoningNoise(`<think>plan</think>\n${JSON_PAYLOAD}`), JSON_PAYLOAD);
    assert.equal(stripReasoningNoise(`<thinking>plan</thinking>${JSON_PAYLOAD}`), JSON_PAYLOAD);
});

test('keeps only the harmony final channel', () => {
    const raw = `<|channel|>analysis<|message|>{"draft":1}<|end|><|start|>assistant<|channel|>final<|message|>${JSON_PAYLOAD}<|return|>`;
    assert.equal(stripReasoningNoise(raw), JSON_PAYLOAD);
});

test('removes the malformed channel variant including its name', () => {
    const raw = `<|channel>thought<channel|>\`\`\`json\n${JSON_PAYLOAD}\n\`\`\``;
    assert.equal(stripReasoningNoise(raw), `\`\`\`json\n${JSON_PAYLOAD}\n\`\`\``);
});

test('removes a closed harmony analysis body when there is no final channel', () => {
    const raw = `<|channel|>analysis<|message|>Plan: {"title":"Draft"} ok<|end|>${JSON_PAYLOAD}`;
    assert.equal(stripReasoningNoise(raw), JSON_PAYLOAD);
});

test('keeps reasoning tags that appear inside the JSON', () => {
    const raw = '{"title":"T","content":"She wrote <analysis> then <thinking>s</thinking> done.","keywords":[]}';
    assert.equal(stripReasoningNoise(`<thinking>plan</thinking></analysis>${raw}`), raw);
});

test('leaves pipe-less angle-bracket words in memory text alone', () => {
    const raw = '{"title":"T","content":"She typed <end> and <message> into the console.","keywords":[]}';
    assert.equal(stripReasoningNoise(raw), raw);
});

test('uses the reasoning template only when it removes a block and leaves JSON', () => {
    const parse = (s) => ({ reasoning: 'r', content: s.replace(/^\[R\][\s\S]*?\[\/R\]/, '').trim() });
    assert.equal(stripReasoningNoise(`[R]why[/R]${JSON_PAYLOAD}`, parse), JSON_PAYLOAD);

    const swallows = () => ({ reasoning: 'r', content: 'prose only' });
    assert.equal(stripReasoningNoise(JSON_PAYLOAD, swallows), JSON_PAYLOAD);

    const noReasoning = (s) => ({ reasoning: '', content: s.slice(1) });
    assert.equal(stripReasoningNoise(JSON_PAYLOAD, noReasoning), JSON_PAYLOAD);

    const keepsReasoningJson = () => ({ reasoning: JSON_PAYLOAD, content: 'Done [1 memory]' });
    assert.equal(stripReasoningNoise(`[R]${JSON_PAYLOAD}[/R]Done [1 memory]`, keepsReasoningJson), `[R]${JSON_PAYLOAD}[/R]Done [1 memory]`);

    const throws = () => { throw new Error('boom'); };
    assert.equal(stripReasoningNoise(JSON_PAYLOAD, throws), JSON_PAYLOAD);
});

test('recovers fields when an unescaped quote breaks the object', () => {
    const broken = '{"title":"Night \\"Raid\\"","content":"Line one\\nLine two","keywords":["raid","night"], "extra": "bad " quote"}';
    assert.deepEqual(recoverMemoryFields([broken]), {
        title: 'Night "Raid"',
        content: 'Line one\nLine two',
        keywords: ['raid', 'night'],
    });
});

test('accepts summary and memory_content as content', () => {
    assert.equal(recoverMemoryFields(['{"title":"T","summary":"S","keywords":[]}']).content, 'S');
    assert.equal(recoverMemoryFields(['{"title":"T","memory_content":"M","keywords":[]}']).content, 'M');
});

test('keeps complete keywords from a cut-off array, possibly none', () => {
    assert.deepEqual(recoverMemoryFields(['{"title":"T","content":"C","keywords":["a","b']).keywords, ['a']);
    assert.deepEqual(recoverMemoryFields(['{"title":"T","content":"C","keywords":["a']).keywords, []);
});

test('recovers with no keywords when the field is missing', () => {
    assert.deepEqual(
        recoverMemoryFields(['{"title":"T","content":"C"}']),
        { title: 'T', content: 'C', keywords: [] },
    );
});

test('splits a comma-separated keywords string', () => {
    assert.deepEqual(
        recoverMemoryFields(['{"title":"T","content":"C","keywords":"a, b ,,c"}']).keywords,
        ['a', 'b', 'c'],
    );
});

test('returns null when content is cut off', () => {
    assert.equal(recoverMemoryFields(['{"title":"T","content":"C and cut']), null);
    assert.equal(recoverMemoryFields(['{"title":"T","content":"C"']), null);
});

test('does not fall back to summary when content is cut off', () => {
    assert.equal(recoverMemoryFields(['{"title":"T","summary":"S","content":"long and cut']), null);
});

test('keeps keywords that contain a closing bracket', () => {
    assert.deepEqual(
        recoverMemoryFields(['{"title":"T","content":"C","keywords":["a[1]","b","c"]}']).keywords,
        ['a[1]', 'b', 'c'],
    );
});

test('a quote before a brace inside the text does not end the value', () => {
    assert.equal(
        recoverMemoryFields(['{"title":"T","content":"He typed "}" and left.","keywords":["a"]}']).content,
        'He typed "}" and left.',
    );
    assert.equal(
        recoverMemoryFields(['```json\n{"title":"T","content":"C "x" end"}\n```\nHope this helps!']).content,
        'C "x" end',
    );
    assert.equal(recoverMemoryFields(['{"memory":{"title":"T","content":"C"}}']).content, 'C');
});

test('recovers a broken object from its brace span when a remark follows it', () => {
    // Newlines are stripped before recovery, so the remark directly follows the brace
    const whole = '{"title":"Night Raid","keywords":["raid"],"content":"Mira said "run and the guards followed."}Hope this helps!';
    const span = whole.slice(whole.indexOf('{'), whole.lastIndexOf('}') + 1);
    assert.equal(recoverMemoryFields([whole]), null);
    assert.equal(recoverMemoryFields([whole, span]).content, 'Mira said "run and the guards followed.');
});

test('a brace inside cut-off content does not make the span recoverable', () => {
    const whole = '{"title":"Night Raid","keywords":["raid"],"content":"Mira checked the ledger {page 4} and then the guards';
    const span = whole.slice(whole.indexOf('{'), whole.lastIndexOf('}') + 1);
    assert.equal(recoverMemoryFields([whole, span]), null);
});

test('returns null without a title or content', () => {
    assert.equal(recoverMemoryFields(['{"content":"C","keywords":[]}']), null);
    assert.equal(recoverMemoryFields(['{"title":"T","keywords":[]}']), null);
});

test('prefers the earliest candidate that has every field', () => {
    const fenced = '{"title":"Final","content":"Real","keywords":["a"]}';
    const whole = 'draft "title":"Draft","content":"Old","keywords":[] then ' + fenced;
    assert.equal(recoverMemoryFields([fenced, whole]).title, 'Final');
});

test('skips a candidate with more than one title key', () => {
    const whole = 'draft {"title":"Draft","content":"Old","keywords":[]} then {"title":"Final","content":"New "x","keywords":["a"]}';
    assert.equal(recoverMemoryFields(['no fields here', whole]), null);
});

test('keeps unescaped quotes inside a value', () => {
    assert.equal(
        recoverMemoryFields(['{"title":"T","content":"He said "no and left.","keywords":["a"]}']).content,
        'He said "no and left.',
    );
    assert.equal(
        recoverMemoryFields(['{"title":"T","content":"He said "no, never" and left.","keywords":["a"]}']).content,
        'He said "no, never" and left.',
    );
});

test('decodes escapes in one pass and tolerates unknown escapes', () => {
    const r = recoverMemoryFields(['{"title":"It\\\'s","content":"a \\\\n b \\u2019 c\\/d","keywords":["k"]}']);
    assert.equal(r.title, "It's");
    assert.equal(r.content, 'a \\n b \u2019 c/d');
});

test('keywords are optional for constant entries', () => {
    assert.equal(memoryKeywordsRequired('blue'), false);
    assert.equal(memoryKeywordsRequired(' Blue ', {}), false);
});

test('vectorized entries need keywords unless Vector Storage handles World Info', () => {
    const on = { vectors: { enabled_world_info: true } };
    assert.equal(memoryKeywordsRequired('link', on), false);
    assert.equal(memoryKeywordsRequired(undefined, on), false);
    assert.equal(memoryKeywordsRequired('link', {}), true);
    assert.equal(memoryKeywordsRequired('link', { vectors: { enabled_world_info: false } }), true);
    assert.equal(memoryKeywordsRequired('link', { ...on, disabledExtensions: ['vectors'] }), true);
});

test('normal entries need keywords unless Vector Storage covers all entries', () => {
    assert.equal(memoryKeywordsRequired('green', { vectors: { enabled_world_info: true } }), true);
    assert.equal(memoryKeywordsRequired('green', { vectors: { enabled_world_info: true, enabled_for_all: true } }), false);
});

test('line breaks: detect keeps breaks inside strings, then offers a spaced fallback', () => {
    const raw = '{\n  "title": "T",\r\n  "content": "Mira left.\nThe guards\tfollowed.",\n  "keywords": ["a"]\n}';
    const [escaped, spaced] = lineBreakVariants(raw, 'detect');
    assert.equal(JSON.parse(escaped).content, 'Mira left.\nThe guards\tfollowed.');
    assert.equal(JSON.parse(spaced).content, 'Mira left. The guards followed.');
    assert.deepEqual(lineBreakVariants(raw, 'space'), [spaced]);
    assert.deepEqual(lineBreakVariants(raw, 'off'), [raw]);
    assert.deepEqual(lineBreakVariants(raw), lineBreakVariants(raw, 'detect'));
});

test('line breaks: quotes in prose around the JSON do not switch detection off', () => {
    const raw = 'Here is the memory for "Chapter 3:\n{"title":"T","content":"Mira left.\nThe guards followed.","keywords":["a"]}\nHope "this helps';
    const [escaped] = lineBreakVariants(raw, 'detect');
    const json = escaped.slice(escaped.indexOf('{'), escaped.lastIndexOf('}') + 1);
    assert.equal(JSON.parse(json).content, 'Mira left.\nThe guards followed.');
});

test('line breaks: text without control characters yields one variant', () => {
    assert.deepEqual(lineBreakVariants('{"title":"T"}', 'detect'), ['{"title":"T"}']);
});

test('line breaks: the spaced variant still recovers when an odd quote throws detection off', () => {
    const raw = '{"title":"T","content":"He said "run.\nThey fled.","keywords":\n["a"]}';
    const variants = lineBreakVariants(raw, 'detect');
    assert.deepEqual(variants, lineBreakVariants(raw, 'space'));
    const recovered = recoverMemoryFields(variants);
    assert.equal(recovered.title, 'T');
    assert.deepEqual(recovered.keywords, ['a']);
    assert.match(recovered.content, /^He said "run\.\s?They fled\.$/);
});

test('usable keywords are trimmed, non-blank strings', () => {
    assert.deepEqual(usableKeywords([' a ', '', '  ', 'b', 3, null]), ['a', 'b']);
    assert.deepEqual(usableKeywords('a, b'), []);
    assert.deepEqual(usableKeywords(undefined), []);
});
