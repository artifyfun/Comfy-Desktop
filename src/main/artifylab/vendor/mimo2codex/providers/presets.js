export const PROVIDER_PRESETS = [
    {
        id: "sensenova",
        displayName: "商汤日日新 (SenseNova)",
        matchBaseUrl: ["sensenova.cn"],
        matchModelPrefix: ["sensenova-", "deepseek-v4-flash"],
        recommendedSpec: {
            baseUrl: "https://token.sensenova.cn/v1",
            defaultModel: "sensenova-6.7-flash-lite",
            docsUrl: "https://platform.sensenova.cn/docs",
            features: {
                // SenseNova 6.7 Flash-Lite 文档表里没列 strict / content:null / response_format，
                // 也没明说 system 数量限制。一并按"严格 OpenAI 子集"防御性清理。
                dropNullStrict: true,
                dropNullContent: true,
                dropToolChoiceAuto: true,
                mergeSystemMessages: true,
                dropResponseFormat: true,
                // SenseNova schema 只接受 tools[].type ∈ {function, custom}，Claude Code / Codex
                // 经常塞 web_search / file_search 等 OpenAI 内置 tool，会被一刀切 400。
                dropNonFunctionTools: true,
                enhanceErrorPreset: "sensenova",
            },
        },
    },
    {
        id: "minimax",
        displayName: "MiniMax",
        matchBaseUrl: ["minimaxi.com", "api.minimax.chat"],
        matchModelPrefix: ["minimax-", "abab"],
        recommendedSpec: {
            baseUrl: "https://api.minimaxi.com/v1",
            defaultModel: "MiniMax-M2",
            docsUrl: "https://platform.minimaxi.com/document",
            features: {
                // 一键预设涵盖 dropNullStrict / dropNullContent / dropToolChoiceAuto /
                // mergeSystemMessages / extractThinkTags。
                minimaxCompat: true,
            },
        },
    },
    {
        id: "kimi",
        displayName: "Kimi (Moonshot)",
        matchBaseUrl: ["moonshot.cn", "moonshot.ai", "platform.kimi"],
        matchModelPrefix: ["kimi-", "moonshot-v1-"],
        recommendedSpec: {
            baseUrl: "https://api.moonshot.cn/v1",
            defaultModel: "kimi-k2.6",
            docsUrl: "https://platform.kimi.com/docs",
            features: {
                // Kimi 不识别 reasoning_effort（用 thinking:{enabled/disabled} 控制思考）。
                // 如果用户开了 admin UI 的"强制高强度思考"，reqToChat 会注 reasoning_effort，
                // 这里把它删掉避免风险（多数情况 Kimi 只是忽略，但严格上游可能 400）。
                dropReasoningEffort: true,
            },
        },
    },
];
// 按 baseUrl 优先匹配（更可靠），失败再按 model 前缀匹配。两者皆未命中返回 null。
export function matchPreset(baseUrl, model) {
    const bu = (baseUrl || "").toLowerCase();
    const m = (model || "").toLowerCase();
    for (const p of PROVIDER_PRESETS) {
        if (p.matchBaseUrl.some((s) => bu.includes(s.toLowerCase())))
            return p;
    }
    for (const p of PROVIDER_PRESETS) {
        if (p.matchModelPrefix.some((s) => m.startsWith(s.toLowerCase())))
            return p;
    }
    return null;
}
// generic.ts 的 enhanceError hook 在 features.enhanceErrorPreset 设值时调用本函数。
// 默认 unset → generic 仍返回 null，行为与之前完全一致。
//
// 命中规则使用 snippet 的内容子串匹配（snippet 是上游 400 响应体的前 800 字符）。
// 返回的 message 拼接原 snippet 方便用户进一步排查。
export function applyEnhanceErrorPreset(preset, status, snippet) {
    const raw = snippet ?? "";
    if (preset === "sensenova") {
        if (status === 400 && raw.includes("Errors in message queue response")) {
            return {
                code: "sensenova_request_validation_failed",
                message: "SenseNova 返回 invalid_request_error (code 3)，但网关未透出具体字段。" +
                    "常见嫌疑：response_format / thinking / max_tokens > 64K / temperature ∉ [0,2] / strict: true / 多条 system 消息。" +
                    "请检查 providers.json 的 features 是否打开了 dropResponseFormat / dropNullStrict / mergeSystemMessages 等推荐开关。" +
                    "文档：https://platform.sensenova.cn/docs。原始 snippet：" +
                    raw,
            };
        }
        if (status === 400 && /invalid temperature/i.test(raw)) {
            return {
                code: "sensenova_temperature_out_of_range",
                message: "SenseNova 要求 temperature ∈ [0,2]。原始：" + raw,
            };
        }
        if (status === 400 && /max_tokens/i.test(raw)) {
            return {
                code: "sensenova_max_tokens_out_of_range",
                message: "SenseNova 6.7 Flash-Lite 要求 max_tokens ∈ [1, 65536]。原始：" + raw,
            };
        }
    }
    // minimax preset — 暂无具体规则（保留扩展位）。
    return null;
}
//# sourceMappingURL=presets.js.map