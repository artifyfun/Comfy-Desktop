import { reqToChat } from "../translate/reqToChat.js";
import { applyMinimaxCompat, } from "../translate/minimaxCompat.js"; // minimax-compat: 后处理 sanitizer
import { applyEnhanceErrorPreset, PROVIDER_PRESETS, } from "./presets.js";
const RESERVED_IDS = new Set(["mimo", "deepseek"]);
// 当 features.enhanceErrorPreset 命中已知厂商预设时，把 preset.recommendedSpec.features
// 中**缺失**的字段补到运行时 features 上。用户已显式配置的字段不会被覆盖（"" / false 也算
// 显式，因为 genericLoader 在 parse 时只在字段为对应类型时才放进 store）。
//
// 这条兜底的存在意义：在新增 sanitizer 子开关后，老 providers.json 的 features 块不带这些
// 字段，但用户选过 `enhanceErrorPreset: "sensenova"` 已经明确表态"我要 sensenova 整套保护"。
// 老配置无需手改 providers.json，重启即享受新开关。前端 UI 仍按 providers.json 原文显示 ——
// 已显式存的字段一致；新字段在 UI 显示为未勾，但运行时实际生效（这是可接受的最小不一致）。
function augmentFeaturesWithPreset(features) {
    if (!features.enhanceErrorPreset)
        return features;
    const preset = PROVIDER_PRESETS.find((p) => p.id === features.enhanceErrorPreset);
    if (!preset)
        return features;
    const out = { ...features };
    for (const [k, v] of Object.entries(preset.recommendedSpec.features)) {
        if (k === "enhanceErrorPreset")
            continue;
        if (out[k] === undefined) {
            out[k] = v;
        }
    }
    return out;
}
export class GenericProviderSpecError extends Error {
    constructor(message) {
        super(message);
        this.name = "GenericProviderSpecError";
    }
}
export function validateSpec(spec) {
    if (!spec.id || typeof spec.id !== "string") {
        throw new GenericProviderSpecError("generic provider spec missing id");
    }
    if (RESERVED_IDS.has(spec.id)) {
        throw new GenericProviderSpecError(`generic provider id "${spec.id}" conflicts with a built-in provider — pick a different id`);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(spec.id)) {
        throw new GenericProviderSpecError(`generic provider id "${spec.id}" must be alphanumeric + dash/underscore (no spaces, no slashes)`);
    }
    if (!spec.baseUrl) {
        throw new GenericProviderSpecError(`generic provider "${spec.id}" missing baseUrl`);
    }
    if (!spec.envKey) {
        throw new GenericProviderSpecError(`generic provider "${spec.id}" missing envKey`);
    }
    if (!spec.defaultModel) {
        throw new GenericProviderSpecError(`generic provider "${spec.id}" missing defaultModel`);
    }
    if (spec.wireApi && spec.wireApi !== "chat" && spec.wireApi !== "responses") {
        throw new GenericProviderSpecError(`generic provider "${spec.id}" has invalid wireApi "${spec.wireApi}" — must be "chat" or "responses"`);
    }
}
export function createGenericProvider(spec) {
    validateSpec(spec);
    const declaredModels = spec.models ?? [];
    const hasDeclaredModels = declaredModels.length > 0;
    const wireApi = spec.wireApi ?? "chat";
    // 用户写在 providers.json 的原始 features。下面 augment 一次得到"运行时"用的版本。
    const features = augmentFeaturesWithPreset(spec.features ?? {});
    return {
        id: spec.id,
        shortcut: spec.shortcut ?? spec.id,
        displayName: spec.displayName ?? spec.id,
        defaultBaseUrl: spec.baseUrl,
        baseUrlEnv: `${spec.envKey.replace(/_API_KEY$/i, "")}_BASE_URL`,
        envKeys: [spec.envKey],
        defaultModel: spec.defaultModel,
        builtinModels: declaredModels,
        wireApi,
        docsUrl: spec.docsUrl,
        detectFlags(_apiKey, _baseUrl) {
            return {};
        },
        resolveModel(clientModel) {
            if (!hasDeclaredModels) {
                // minimax-compat: forceDefaultModel 时返回 null，让 selectProvider 把
                // upstreamModel 改写为本 provider 的 defaultModel（用于 MiniMax 等
                // 需要把任意客户端模型名强制覆盖为单一上游模型的场景）。
                if (spec.forceDefaultModel)
                    return null;
                // Untyped passthrough — accept any model id and let the upstream
                // validate. This is the design choice that matches Codex's habit of
                // "whatever model = "..." is in config.toml gets sent verbatim".
                return { id: clientModel };
            }
            for (const m of declaredModels) {
                if (m.id === clientModel)
                    return m;
                if (m.aliases?.includes(clientModel))
                    return m;
            }
            return null;
        },
        preprocessResponses(req, ctx) {
            const chat = reqToChat(req, {
                forceParallelToolCalls: !!features.forceParallelToolCalls,
                enableWebSearch: !!features.webSearch,
                imageDropDir: ctx.dataDir,
                disableThinking: ctx.disableThinking,
                forceHighEffort: ctx.forceHighEffort,
                upstreamModel: ctx.upstreamModel,
            });
            // Generic OpenAI-compat upstreams don't understand MiMo's `thinking` family —
            // strip it. 然后**自己**翻成 sensenova 等接受的 reasoning_effort:"none"，
            // 因为 reqToChat 只发标准 thinking 信号、不知道下游是谁。
            delete chat.thinking;
            delete chat.enable_thinking;
            if (ctx.disableThinking) {
                chat.reasoning_effort = "none";
            }
            return applyMinimaxCompat(chat, features); // minimax-compat: 关闭时是恒等
        },
        preprocessChat(req, ctx) {
            const out = { ...req };
            delete out.thinking;
            delete out.enable_thinking;
            if (ctx.disableThinking) {
                // chat completions 路径：直接覆盖 reasoning_effort 表达"关思考"。
                // sensenova 接受 "none"；其他 generic 上游可能不识别但通常忽略未知值。
                out.reasoning_effort = "none";
            }
            return applyMinimaxCompat(out, features); // minimax-compat: 关闭时是恒等
        },
        preprocessResponsesPassthrough(req, _ctx) {
            // Identity passthrough — the routing layer will substitute `model`
            // separately. Hook exists so users can later override for upstream
            // quirks without changing the server's branching logic.
            return req;
        },
        enhanceError({ status, snippet }) {
            // 未设 enhanceErrorPreset → 行为与之前完全一致（return null）。
            if (features.enhanceErrorPreset) {
                return applyEnhanceErrorPreset(features.enhanceErrorPreset, status, snippet);
            }
            return null;
        },
        // minimax-compat: 响应侧 inline <think>...</think> 切分开关。features.minimaxCompat
        // 一键预设包揽；也可独立打开 features.extractThinkTags（部分 GLM/Qwen-thinking
        // 模型同样是 inline think 格式）。
        responseFlags: {
            extractInlineThink: !!features.minimaxCompat || !!features.extractThinkTags,
        },
    };
}
//# sourceMappingURL=generic.js.map