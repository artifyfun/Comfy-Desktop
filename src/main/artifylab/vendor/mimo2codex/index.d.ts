/** Type shims for the vendored (plain-JS) mimo2codex conversion core. MIT, © 7as0nch */
declare module '*/vendor/mimo2codex/providers/generic.js' {
  export interface GenericProviderSpec {
    id: string
    displayName?: string
    baseUrl: string
    envKey: string
    wireApi?: 'chat' | 'responses'
    defaultModel?: string
    models?: Array<{ id: string }>
    features?: Record<string, unknown>
  }
  export interface ProviderRuntime {
    baseUrl: string
    apiKey: string
  }
  export interface PreprocessContext {
    runtime: ProviderRuntime
    exposeReasoning: boolean
    dataDir?: string
    disableThinking: boolean
    forceHighEffort: boolean
    webSearchEnabled: boolean
    upstreamModel: string
  }
  export interface GenericProvider {
    id: string
    wireApi: 'chat' | 'responses'
    preprocessResponses(
      req: Record<string, unknown>,
      ctx: PreprocessContext
    ): Record<string, unknown>
    enhanceError(err: unknown): Error
    responseFlags?: { extractInlineThink?: boolean }
    supportsVision?(model: string): boolean
    resolveModel(id: string): { id: string } | undefined
  }
  export function validateSpec(spec: GenericProviderSpec): void
  export function createGenericProvider(spec: GenericProviderSpec): GenericProvider
}
declare module '*/vendor/mimo2codex/upstream/openaiCompatClient.js' {
  export declare class UpstreamError extends Error {
    status: number
    code: string
    bodySnippet?: string
    constructor(message: string, status?: number, code?: string)
  }
  export declare function callOpenAICompat(
    cfg: {
      baseUrl: string
      apiKey: string
      userAgent?: string
      contextOverflowMode: 'passthrough' | 'friendly'
      modelInfo: { id: string; contextWindow?: number }
      maxRetries?: number
    },
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response>
}
declare module '*/vendor/mimo2codex/upstream/chatStream.js' {
  export declare function iterChatStreamChunks(
    response: Response
  ): AsyncGenerator<Record<string, unknown>>
}
declare module '*/vendor/mimo2codex/translate/respToResponses.js' {
  export declare function respToResponses(
    chatJson: Record<string, unknown>,
    originalReq: Record<string, unknown>,
    opts: {
      exposeReasoning?: boolean
      extractInlineThink?: boolean
      namespaceMap?: unknown
    }
  ): Record<string, unknown>
}
declare module '*/vendor/mimo2codex/translate/streamToSse.js' {
  export interface ResponseSink {
    write(event: string, data: unknown): void
    comment(text: string): void
    end(): void
    closed(): boolean
  }
  export interface PipeResult {
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    response?: Record<string, unknown>
    toolCallCount?: number
  }
  export declare function pipeChatStreamToResponses(
    sink: ResponseSink,
    source: { chunks: AsyncGenerator<Record<string, unknown>> },
    req: Record<string, unknown>,
    opts: { exposeReasoning?: boolean; extractInlineThink?: boolean; namespaceMap?: unknown }
  ): Promise<PipeResult>
}
