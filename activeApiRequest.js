// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

// Sends a prompt through SillyTavern's active API the way generateRaw does,
// but with an AbortSignal, so stopping STMB cancels the backend request.
// generateRaw itself only listens for the global GENERATION_STOPPED event,
// which would also stop group auto-mode, /inject cleanup and other
// extensions' requests. ST helpers are injected so this file stays testable.

function stopError() {
    return new DOMException('STMB generation stopped', 'AbortError');
}

function hasAll(deps, names) {
    return names.every(name => typeof deps?.[name] === 'function');
}

const SHARED_HELPERS = ['createRawPrompt', 'extractMessageFromData', 'cleanUpMessage'];
const TEXT_COMPLETION_HELPERS = [...SHARED_HELPERS, 'getTextGenGenerationData', 'getGenerateUrl', 'getRequestHeaders', 'fetch'];
const CHAT_COMPLETION_HELPERS = [...SHARED_HELPERS, 'sendOpenAIRequest'];

/**
 * Which request path a main API uses.
 * @param {string} api
 * @param {object} deps
 * @returns {'text'|'chat'|'fallback'}
 */
export function getActiveApiRoute(api, deps) {
    const canEmit = typeof deps?.eventSource?.emit === 'function' && deps?.eventTypes;
    if (api === 'textgenerationwebui' && canEmit && hasAll(deps, TEXT_COMPLETION_HELPERS)) return 'text';
    if (api === 'openai' && canEmit && typeof deps.eventSource.on === 'function'
        && typeof deps.eventSource.removeListener === 'function' && hasAll(deps, CHAT_COMPLETION_HELPERS)) {
        return 'chat';
    }
    return 'fallback';
}

function cleanMessage(deps, data, api) {
    return deps.cleanUpMessage({
        getMessage: deps.extractMessageFromData(data, api),
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: true,
        includeUserPromptBias: false,
        trimNames: true,
        trimWrongNames: true,
    });
}

async function sendTextCompletion({ prompt, responseLength, signal, deps }) {
    const api = 'textgenerationwebui';
    const eventData = { prompt: deps.createRawPrompt(prompt, api, false, false, '', ''), dryRun: false };
    await deps.eventSource.emit(deps.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
    if (signal?.aborted) throw stopError();

    const maxTokens = responseLength ?? deps.amountGen;
    const body = await deps.getTextGenGenerationData(eventData.prompt, maxTokens, false, false, null, 'quiet');
    const response = await deps.fetch(deps.getGenerateUrl(api), {
        method: 'POST',
        headers: deps.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Text Completion request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }
    const data = await response.json();
    if (data?.error) {
        throw new Error(String(data.response || data.error));
    }
    return cleanMessage(deps, data, api);
}

async function sendChatCompletion({ prompt, responseLength, signal, deps }) {
    const api = 'openai';
    const eventData = { chat: deps.createRawPrompt(prompt, api, false, false, '', ''), dryRun: false };
    await deps.eventSource.emit(deps.eventTypes.CHAT_COMPLETION_PROMPT_READY, eventData);
    if (signal?.aborted) throw stopError();

    // Same approach as ST's TempResponseLength: sendOpenAIRequest reads
    // max_tokens from the global preset, so override it on the way out.
    const settingsEvent = deps.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
    const setMaxTokens = (generateData) => {
        deps.eventSource.removeListener(settingsEvent, setMaxTokens);
        if (generateData && typeof generateData === 'object') {
            generateData.max_tokens = responseLength;
        }
    };
    if (responseLength) {
        deps.eventSource.on(settingsEvent, setMaxTokens);
    }
    try {
        const data = await deps.sendOpenAIRequest('quiet', eventData.chat, signal);
        return cleanMessage(deps, data, api);
    } finally {
        deps.eventSource.removeListener(settingsEvent, setMaxTokens);
    }
}

async function sendViaGenerateRaw({ prompt, responseLength, signal, deps }) {
    if (typeof deps?.generateRaw !== 'function') {
        throw new Error('context.generateRaw is unavailable.');
    }
    const request = deps.generateRaw({
        prompt,
        systemPrompt: '',
        prefill: '',
        responseLength,
        jsonSchema: null,
    });
    request.catch(() => {});

    // generateRaw takes no AbortSignal: stop waiting when STMB is stopped.
    // The request may finish in the background; its result is discarded.
    let removeAbortListener = () => {};
    const aborted = new Promise((_, reject) => {
        if (!signal) return;
        const onAbort = () => reject(stopError());
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    try {
        const raw = await Promise.race([request, aborted]);
        return typeof raw === 'string' ? raw : String(raw?.text ?? raw?.content ?? '');
    } finally {
        removeAbortListener();
    }
}

/**
 * Generate text for `prompt` through SillyTavern's active API.
 * No JSON schema is used; the caller parses the reply.
 * @param {object} options
 * @param {string} options.prompt
 * @param {number|null} [options.responseLength] - null uses SillyTavern's own setting
 * @param {AbortSignal|null} [options.signal]
 * @param {object} options.deps - SillyTavern helpers (see stmemory.js)
 * @returns {Promise<string>}
 */
export async function sendActiveApiRequest({ prompt, responseLength = null, signal = null, deps = {} }) {
    if (signal?.aborted) throw stopError();
    const args = { prompt, responseLength, signal, deps };
    switch (getActiveApiRoute(deps.mainApi, deps)) {
        case 'text': return await sendTextCompletion(args);
        case 'chat': return await sendChatCompletion(args);
        default: return await sendViaGenerateRaw(args);
    }
}
