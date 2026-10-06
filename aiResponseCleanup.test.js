// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverMemoryFields, stripReasoningNoise } from './aiResponseCleanup.js';

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

test('returns null when keywords are truncated or missing', () => {
    assert.equal(recoverMemoryFields(['{"title":"T","content":"C","keywords":["a","b']), null);
    assert.equal(recoverMemoryFields(['{"title":"T","content":"C"']), null);
});

test('returns null without a title or content', () => {
    assert.equal(recoverMemoryFields(['{"content":"C","keywords":[]}']), null);
    assert.equal(recoverMemoryFields(['{"title":"T","keywords":[]}']), null);
});

test('prefers the earliest candidate that has every field', () => {
    const fenced = '{"title":"Final","content":"Real","keywords":["a"]';
    const whole = 'draft "title":"Draft","content":"Old","keywords":[] then ' + fenced;
    assert.equal(recoverMemoryFields([fenced, whole]).title, 'Final');
    assert.equal(recoverMemoryFields(['no fields here', whole]).title, 'Draft');
});
