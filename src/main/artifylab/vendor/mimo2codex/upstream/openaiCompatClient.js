import { log, redactKey } from "../util/log.js";
import { detectContextOverflow, detectMalformedJsonField } from "./contextOverflow.js";
export class UpstreamError extends Error {
    status;
    bodySnippet;
    code;
    constructor(opts) {
        super(opts.message);
        this.name = "UpstreamError";
        this.status = opts.status;
        this.code = opts.code;
        this.bodySnippet = opts.bodySnippet;
    }
}
function buildUrl(baseUrl, path) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${trimmed}${normalizedPath}`;
}
function authHeader(apiKey) {
    // Both MiMo and DeepSeek accept the OpenAI-style Bearer scheme, which is
    // also more universally supported by intermediaries than the api-key header.
    return { Authorization: `Bearer ${apiKey}` };
}
async function readSnippet(res) {
    try {
        const text = await res.text();
        return text.length > 800 ? `${text.slice(0, 800)}…` : text;
    }
    catch {
        return undefined;
    }
}
function describeFetchError(err) {
    const e = err;
    return {
        error: e.message,
        cause: e.cause?.message,
        code: e.cause?.code,
    };
}
// Statuses worth retrying: rate limits + transient upstream/gateway failures.
// 429 is the big one — without proxy-side retry, Codex burns its own
// `request_max_retries` and surfaces "exceeded retry limit, last status: 429".
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
// undici's timeout error codes (surfaced on err.cause.code). These mean we
// already WAITED the full headers/body window — retrying just re-sends the
// (often huge) request and multiplies the dead-air Codex sees, which is what
// trips its own "stream disconnected before completion". So we fail fast
// instead of treating them like a quick ECONNREFUSED. Tune the window via
// MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS / _BODY_TIMEOUT_MS (see proxyDispatcher).
const TIMEOUT_CAUSE_CODES = new Set([
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
]);
function envInt(name, def, min, max) {
    const raw = process.env[name];
    if (!raw)
        return def;
    const n = Number(raw);
    if (!Number.isFinite(n))
        return def;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}
// How long to wait before the next attempt. Honors a numeric or HTTP-date
// `Retry-After` header (capped so Codex doesn't time out waiting on us), else
// exponential backoff with jitter.
function retryDelayMs(res, attempt, baseMs) {
    const CAP = 10_000;
    if (res) {
        const ra = res.headers.get("retry-after");
        if (ra) {
            const secs = Number(ra);
            if (Number.isFinite(secs))
                return Math.min(Math.max(secs, 0) * 1000, CAP);
            const when = Date.parse(ra);
            if (!Number.isNaN(when))
                return Math.min(Math.max(when - Date.now(), 0), CAP);
        }
    }
    const exp = baseMs * 2 ** attempt;
    return Math.min(exp, 12_000) + Math.floor(Math.random() * 250);
}
// setTimeout that rejects (AbortError) if the request is cancelled mid-wait,
// so a Codex cancel during backoff doesn't leave us sleeping.
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            const e = new Error("aborted");
            e.name = "AbortError";
            return reject(e);
        }
        const t = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(t);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function defaultErrorCode(status) {
    if (status === 401)
        return "authentication_error";
    if (status === 403)
        return "permission_denied";
    if (status === 429)
        return "rate_limit_exceeded";
    if (status >= 500)
        return "server_error";
    return "bad_request";
}
export async function callOpenAICompat(cfg, body, signal) {
    return await postUpstream(cfg, "/chat/completions", body, signal, {
        summary: {
            model: body.model,
            stream: !!body.stream,
            messages: body.messages.length,
            tools: body.tools?.length ?? 0,
        },
        streaming: !!body.stream,
    });
}
// Direct Responses-API passthrough. Used when Provider.wireApi === "responses"
// — the body is sent untouched to the upstream's /v1/responses endpoint.
// Lets generic providers that natively speak the Codex Responses API skip
// the Chat-Completions translation round-trip.
export async function callResponsesPassthrough(cfg, body, signal) {
    return await postUpstream(cfg, "/responses", body, signal, {
        summary: {
            model: body.model,
            stream: !!body.stream,
            inputItems: Array.isArray(body.input) ? body.input.length : 0,
            tools: body.tools?.length ?? 0,
        },
        streaming: !!body.stream,
    });
}
async function postUpstream(cfg, path, body, signal, meta) {
    const url = buildUrl(cfg.baseUrl, path);
    const headers = {
        "Content-Type": "application/json",
        Accept: meta.streaming ? "text/event-stream" : "application/json",
        "User-Agent": cfg.userAgent,
        ...authHeader(cfg.apiKey),
    };
    log.debug(`upstream POST ${url}`, { ...meta.summary, apiKey: redactKey(cfg.apiKey) });
    log.debug("upstream POST body", body);
    const maxRetries = cfg.maxRetries ?? envInt("MIMO2CODEX_UPSTREAM_MAX_RETRIES", 6, 0, 12);
    const baseMs = cfg.retryBaseMs ?? envInt("MIMO2CODEX_UPSTREAM_RETRY_BASE_MS", 500, 50, 5_000);
    const serialized = JSON.stringify(body);
    const doFetch = () => fetch(url, { method: "POST", headers, body: serialized, signal });
    let attempt = 0;
    for (;;) {
        let res;
        try {
            res = await doFetch();
        }
        catch (err) {
            if (err.name === "AbortError")
                throw err;
            const detail = describeFetchError(err);
            // Timeout class: we already waited the full window. Don't retry — fail
            // fast with a 504 that names the timeout and points at the env knobs, so
            // a large-context / image-heavy request degrades cleanly instead of
            // re-sending the body N times while Codex silently disconnects.
            if (detail.code && TIMEOUT_CAUSE_CODES.has(detail.code)) {
                log.warn(`upstream timed out (${detail.code}); not retrying`, detail);
                throw new UpstreamError({
                    status: 504,
                    code: "upstream_timeout",
                    message: `upstream timed out before responding (${detail.code}). ` +
                        `This usually means the request is too large (long context or a big image) so the model's ` +
                        `first token took longer than the configured window. ` +
                        `请求可能过大（上下文过长或图片过大），上游首字节超时。` +
                        `Raise MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS / _BODY_TIMEOUT_MS (0=off), ` +
                        `or shrink the conversation / image and retry.`,
                });
            }
            // Network-level failure (connect refused / DNS / reset). Retry with
            // backoff like a transient status, then give up with a 502.
            if (attempt < maxRetries) {
                const delay = retryDelayMs(null, attempt, baseMs);
                log.warn(`upstream connect failed, retry ${attempt + 1}/${maxRetries} in ${delay}ms`, describeFetchError(err));
                await abortableSleep(delay, signal);
                attempt++;
                continue;
            }
            throw new UpstreamError({
                status: 502,
                code: "upstream_unreachable",
                message: detail.code
                    ? `failed to reach upstream: ${detail.error} (${detail.code}${detail.cause ? `: ${detail.cause}` : ""})`
                    : `failed to reach upstream: ${detail.error}`,
            });
        }
        if (res.ok)
            return res;
        // Transient status (rate limit / gateway) → consume the body and retry so
        // a brief 429 doesn't bubble up to Codex and break the session.
        if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
            const snippet = await readSnippet(res);
            const delay = retryDelayMs(res, attempt, baseMs);
            log.warn(`upstream ${res.status} ${res.statusText}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`, { snippet: snippet?.slice(0, 200) });
            await abortableSleep(delay, signal);
            attempt++;
            continue;
        }
        // Terminal failure: build the (possibly enhanced) error and throw.
        const snippet = await readSnippet(res);
        // Provider-specific enhancement runs first so dedicated rules (e.g. MiMo's
        // "webSearchEnabled is false" hint) keep winning over the generic
        // context-overflow detector below.
        let enhanced = cfg.enhanceError?.({ status: res.status, snippet });
        if (!enhanced && (cfg.contextOverflowMode ?? "friendly") === "friendly") {
            enhanced = detectContextOverflow({
                status: res.status,
                snippet,
                modelId: cfg.modelInfo?.id,
                contextWindow: cfg.modelInfo?.contextWindow,
            });
        }
        if (!enhanced) {
            // Independent of contextOverflowMode — the malformed-field hint is a
            // diagnostic, not a UX rewrite of a known-bad-prompt case. Surface it
            // even when contextOverflowMode === "passthrough".
            enhanced = detectMalformedJsonField({ status: res.status, snippet });
        }
        const code = enhanced?.code ?? defaultErrorCode(res.status);
        const message = enhanced?.message ?? `upstream returned ${res.status}: ${snippet ?? "(no body)"}`;
        if (enhanced) {
            log.warn(enhanced.message);
        }
        throw new UpstreamError({
            status: res.status,
            code,
            message,
            bodySnippet: snippet,
        });
    }
}
//# sourceMappingURL=openaiCompatClient.js.map