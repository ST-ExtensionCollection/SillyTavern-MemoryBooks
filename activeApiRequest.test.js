// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { getActiveApiRoute, sendActiveApiRequest } from './activeApiRequest.js';

const EVENT_TYPES = {
    GENERATE_AFTER_COMBINE_PROMPTS: 'combine',
    CHAT_COMPLETION_PROMPT_READY: 'chat_ready',
    CHAT_COMPLETION_SETTINGS_READY: 'settings_ready',
};

function makeEventSource() {
    const listeners = new Map();
    const emitted = [];
    return {
        emitted,
        listenerCount: (name) => (listeners.get(name) || []).length,
        on(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(x => x !== fn)); },
        async emit(name, data) {
            emitted.push({ name, data: structuredClone(data) });
            for (const fn of [...(listeners.get(name) || [])]) await fn(data);
        },
    };
}

function makeDeps(overrides = {}) {
    const eventSource = makeEventSource();
    const calls = { fetch: [], openai: [], generateRaw: [], textgen: [] };
    const deps = {
        mainApi: 'textgenerationwebui',
        amountGen: 250,
        eventSource,
        eventTypes: EVENT_TYPES,
        createRawPrompt: (prompt, api) => (api === 'openai' ? [{ role: 'user', content: prompt }] : `<inst>${prompt}</inst>`),
        getTextGenGenerationData: async (prompt, maxTokens, ...rest) => {
            calls.textgen.push({ prompt, maxTokens, rest });
            return { prompt, max_new_tokens: maxTokens };
        },
        getGenerateUrl: () => '/api/backends/text-completions/generate',
        getRequestHeaders: () => ({ 'X-Test': '1' }),
        fetch: async (url, init) => {
            calls.fetch.push({ url, init });
            return { ok: true, json: async () => ({ text: ' reply ' }) };
        },
        sendOpenAIRequest: async (type, messages, signal) => {
            const generateData = { max_tokens: 300 };
            await eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_SETTINGS_READY, generateData);
            calls.openai.push({ type, messages, signal, generateData });
            return { choices: [{ message: { content: ' chat reply ' } }] };
        },
        extractMessageFromData: (data) => data.text ?? data.choices[0].message.content,
        cleanUpMessage: ({ getMessage }) => getMessage.trim(),
        generateRaw: async (args) => {
            calls.generateRaw.push(args);
            return 'raw reply';
        },
        ...overrides,
    };
    return { deps, calls, eventSource };
}

test('text completion sends its own request with the signal', async () => {
    const { deps, calls, eventSource } = makeDeps();
    const controller = new AbortController();
    const text = await sendActiveApiRequest({ prompt: 'P', responseLength: 900, signal: controller.signal, deps });

    assert.equal(text, 'reply');
    assert.equal(calls.generateRaw.length, 0);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0].url, '/api/backends/text-completions/generate');
    assert.equal(calls.fetch[0].init.signal, controller.signal);
    assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { prompt: '<inst>P</inst>', max_new_tokens: 900 });
    assert.deepEqual(calls.textgen[0].rest, [false, false, null, 'quiet']);
    assert.deepEqual(eventSource.emitted[0], { name: 'combine', data: { prompt: '<inst>P</inst>', dryRun: false } });
});

test('text completion uses the prompt as changed by the combine event', async () => {
    const { deps, calls, eventSource } = makeDeps();
    eventSource.on('combine', (data) => { data.prompt += '!'; });
    await sendActiveApiRequest({ prompt: 'P', deps });
    assert.equal(JSON.parse(calls.fetch[0].init.body).prompt, '<inst>P</inst>!');
});

test('text completion falls back to SillyTavern response length when unset', async () => {
    const { deps, calls } = makeDeps();
    await sendActiveApiRequest({ prompt: 'P', responseLength: null, deps });
    assert.equal(calls.textgen[0].maxTokens, 250);
});

test('text completion reports backend failures', async () => {
    const { deps } = makeDeps({
        fetch: async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' }),
    });
    await assert.rejects(sendActiveApiRequest({ prompt: 'P', deps }), /500 Server Error - boom/);

    const { deps: errorDeps } = makeDeps({
        fetch: async () => ({ ok: true, json: async () => ({ error: true, response: 'backend said no' }) }),
    });
    await assert.rejects(sendActiveApiRequest({ prompt: 'P', deps: errorDeps }), /backend said no/);
});

test('aborting cancels the text completion fetch', async () => {
    let seenSignal = null;
    const { deps } = makeDeps({
        fetch: (url, init) => new Promise((_, reject) => {
            seenSignal = init.signal;
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const controller = new AbortController();
    const pending = sendActiveApiRequest({ prompt: 'P', signal: controller.signal, deps });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(seenSignal.aborted, true);
});

test('an already-aborted signal sends nothing', async () => {
    const { deps, calls } = makeDeps();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sendActiveApiRequest({ prompt: 'P', signal: controller.signal, deps }), { name: 'AbortError' });
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.generateRaw.length, 0);
});

test('chat completion passes the signal and overrides max tokens once', async () => {
    const { deps, calls, eventSource } = makeDeps({ mainApi: 'openai' });
    const controller = new AbortController();
    const text = await sendActiveApiRequest({ prompt: 'P', responseLength: 1200, signal: controller.signal, deps });

    assert.equal(text, 'chat reply');
    assert.equal(calls.openai[0].type, 'quiet');
    assert.equal(calls.openai[0].signal, controller.signal);
    assert.deepEqual(calls.openai[0].messages, [{ role: 'user', content: 'P' }]);
    assert.equal(calls.openai[0].generateData.max_tokens, 1200);
    assert.equal(eventSource.listenerCount('settings_ready'), 0);
    assert.deepEqual(eventSource.emitted[0], { name: 'chat_ready', data: { chat: [{ role: 'user', content: 'P' }], dryRun: false } });
});

test('chat completion leaves max tokens alone when unset', async () => {
    const { deps, calls } = makeDeps({ mainApi: 'openai' });
    await sendActiveApiRequest({ prompt: 'P', deps });
    assert.equal(calls.openai[0].generateData.max_tokens, 300);
});

test('chat completion removes the max tokens listener on failure', async () => {
    const { deps, eventSource } = makeDeps({
        mainApi: 'openai',
        sendOpenAIRequest: async () => { throw new Error('provider down'); },
    });
    await assert.rejects(sendActiveApiRequest({ prompt: 'P', responseLength: 1200, deps }), /provider down/);
    assert.equal(eventSource.listenerCount('settings_ready'), 0);
});

test('other APIs and missing helpers fall back to generateRaw', async () => {
    for (const mainApi of ['kobold', 'koboldhorde', 'novel']) {
        const { deps, calls } = makeDeps({ mainApi });
        assert.equal(await sendActiveApiRequest({ prompt: 'P', responseLength: 700, deps }), 'raw reply');
        assert.deepEqual(calls.generateRaw[0], { prompt: 'P', systemPrompt: '', prefill: '', responseLength: 700, jsonSchema: null });
    }
    const { deps } = makeDeps({ getTextGenGenerationData: undefined });
    assert.equal(getActiveApiRoute('textgenerationwebui', deps), 'fallback');
    const { deps: noOpenAI } = makeDeps({ sendOpenAIRequest: undefined });
    assert.equal(getActiveApiRoute('openai', noOpenAI), 'fallback');
});

test('aborting the generateRaw fallback stops waiting', async () => {
    const { deps } = makeDeps({ mainApi: 'kobold', generateRaw: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = sendActiveApiRequest({ prompt: 'P', signal: controller.signal, deps });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});

test('fallback without generateRaw reports it', async () => {
    const { deps } = makeDeps({ mainApi: 'novel', generateRaw: undefined });
    await assert.rejects(sendActiveApiRequest({ prompt: 'P', deps }), /generateRaw is unavailable/);
});
