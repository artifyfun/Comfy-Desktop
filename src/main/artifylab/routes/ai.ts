import express from 'express'
import { CONFIG, HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { handleApiError, createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { fetchWithRetry, createOpenAIRequestOptions, handleStreamResponse } from '../utils/fetch'

interface TestConnectionRequest {
  api_key?: string
  base_url?: string
  model?: string
}

/**
 * AI 相关接口：连接测试 / 提示词优化 / 应用生成 / 代码修改（自 server.ts 平移）。
 */
export function createAiRouter(): express.Router {
  const router = express.Router()
  router.post(
    '/api/test-connection',
    async (req: express.Request<object, object, TestConnectionRequest>, res: express.Response) => {
      try {
        const { api_key, base_url, model } = req.body
        const apiKey = api_key || process.env.OPENAI_API_KEY

        if (!apiKey) {
          return res
            .status(HTTP_STATUS.BAD_REQUEST)
            .json(createErrorResponse('API key is required for testing'))
        }

        const baseUrl = base_url || CONFIG.OPENAI_BASE_URL
        const modelId = model || CONFIG.MODEL_ID

        logger.info('Testing OpenAI API connection', { baseUrl, modelId })

        const requestOptions = createOpenAIRequestOptions(
          apiKey,
          modelId,
          [{ role: 'user', content: 'hi' }],
          {
            max_tokens: 50,
            temperature: 0
          }
        )

        const response = await fetchWithRetry(`${baseUrl}/chat/completions`, requestOptions)
        const data = (await response.json()) as {
          error?: { message?: string }
          choices?: Array<{ message?: { content?: string } }>
        }

        if (!response.ok) {
          throw new Error(data.error?.message || 'Connection test failed')
        }

        if (data?.choices?.[0]?.message) {
          return res
            .status(HTTP_STATUS.OK)
            .json(
              createSuccessResponse(
                { response: data.choices[0].message.content },
                'Connection test successful'
              )
            )
        } else {
          throw new Error('Received invalid response format')
        }
      } catch (error) {
        handleApiError(error, res)
      }
    }
  )

  // 优化提示词接口
  router.post('/api/optimize-prompt', async (req: express.Request, res: express.Response) => {
    try {
      const { prompt, language, api_key, base_url, model } = req.body

      if (!prompt) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('Missing prompt field'))
      }

      const apiKey = api_key || process.env.OPENAI_API_KEY
      if (!apiKey) {
        return res
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .json(createErrorResponse('OpenAI API key is not configured.'))
      }

      const baseUrl = base_url || CONFIG.OPENAI_BASE_URL
      const modelId = model || CONFIG.MODEL_ID

      const systemPrompt =
        language === 'zh'
          ? '你是一个专业的提示词优化助手。你的任务是改进用户的提示词，使其更加清晰、具体和有效。保持用户的原始意图，但使提示词更加结构化，更容易被AI理解。只输出优化后的提示词文本，不要使用Markdown语法，不要添加任何解释、评论或额外标记。必要时可以使用换行符或空格来格式化文本，使其更易读。'
          : "You are a professional prompt optimization assistant. Your task is to improve the user's prompt to make it clearer, more specific, and more effective. Maintain the user's original intent but make the prompt more structured and easier for AI to understand. Output only the plain text of the optimized prompt without any Markdown syntax, explanations, comments, or additional markers. You may use <br> and spaces to format the text when necessary to improve readability."

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]

      const requestOptions = createOpenAIRequestOptions(apiKey, modelId, messages, {
        temperature: 0.7,
        max_tokens: 10000
      })

      logger.info('Sending prompt optimization request', { baseUrl, modelId })

      const response = await fetchWithRetry(`${baseUrl}/chat/completions`, requestOptions)
      const data = (await response.json()) as any

      if (!response.ok) {
        throw new Error(data?.message || 'Error calling OpenAI API')
      }

      const optimizedPrompt = data.choices?.[0]?.message?.content?.trim()

      return res.status(HTTP_STATUS.OK).json(createSuccessResponse({ optimizedPrompt }))
    } catch (error) {
      handleApiError(error, res)
    }
  })

  // 生成应用接口
  router.post('/api/generate-app', async (req: express.Request, res: express.Response) => {
    try {
      const { max_tokens, temperature, api_key, base_url, model, prompt } = req.body

      if (!prompt) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('Missing required fields prompt'))
      }

      // 记录请求信息
      const clientIp =
        req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress
      logger.info('API request received', {
        clientIp,
        rateLimit: (req as any).rateLimit,
        path: req.path
      })

      // 设置流式响应头
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Transfer-Encoding', 'chunked')
      res.setHeader('X-Accel-Buffering', 'no')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Keep-Alive', 'timeout=120')
      res.flushHeaders()

      const apiKey = api_key || process.env.OPENAI_API_KEY
      if (!apiKey) {
        if (!res.headersSent) {
          return res
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .json(createErrorResponse('OpenAI API key is not configured.'))
        }
        return res.end()
      }

      const baseUrl = base_url || CONFIG.OPENAI_BASE_URL
      const modelId = model || CONFIG.MODEL_ID

      logger.info('Generating app', { baseUrl, modelId, max_tokens, temperature })

      const messages = prompt
        ? [
            { role: 'system', content: prompt.systemPrompt },
            { role: 'assistant', content: prompt.assistantPrompt },
            { role: 'user', content: prompt.userPrompt }
          ]
        : []

      const requestOptions = createOpenAIRequestOptions(apiKey, modelId, messages, {
        stream: true,
        max_tokens: max_tokens || CONFIG.DEFAULT_MAX_TOKENS,
        temperature: temperature !== undefined ? temperature : CONFIG.DEFAULT_TEMPERATURE
      })

      const response = await fetchWithRetry(`${baseUrl}/chat/completions`, requestOptions)

      if (!response.ok) {
        const data = (await response.json()) as any
        throw new Error(data?.message || 'Error calling OpenAI API')
      }

      // 处理流式响应
      await handleStreamResponse(
        response,
        (content) => {
          if (!res.writableEnded) {
            res.write(content)
          }
        },
        '</html>'
      )

      if (!res.writableEnded) {
        res.end()
      }
    } catch (error) {
      handleApiError(error, res)
    }
  })

  // 修改代码接口
  router.post('/api/modify-code', async (req: express.Request, res: express.Response) => {
    try {
      const { prompt, language, api_key, base_url, model } = req.body

      if (!prompt) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('Missing prompt field'))
      }

      const apiKey = api_key || process.env.OPENAI_API_KEY
      if (!apiKey) {
        return res
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .json(createErrorResponse('OpenAI API key is not configured.'))
      }

      const baseUrl = base_url || CONFIG.OPENAI_BASE_URL
      const modelId = model || CONFIG.MODEL_ID

      const systemPrompt =
        language === 'zh'
          ? '你是一个专业的代码修改助手。你的任务是根据用户要求，修改用户提供的代码。只输出修改后的代码文本，不要使用Markdown语法，不要添加任何解释、评论或额外标记。'
          : "You are a professional code modification assistant. Your task is to modify the user's code according to the user's requirements. Output only the modified code text without any Markdown syntax, explanations, comments, or additional markers."

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]

      const requestOptions = createOpenAIRequestOptions(apiKey, modelId, messages, {
        temperature: 0.7,
        max_tokens: 10000
      })

      logger.info('Sending code modification request', { baseUrl, modelId })

      const response = await fetchWithRetry(`${baseUrl}/chat/completions`, requestOptions)
      const data = (await response.json()) as any

      if (!response.ok) {
        throw new Error(data?.message || 'Error calling OpenAI API')
      }

      const code = data.choices?.[0]?.message?.content?.trim()

      return res.status(HTTP_STATUS.OK).json(createSuccessResponse({ code }))
    } catch (error) {
      handleApiError(error, res)
    }
  })

  router.post('/api/build/styles', async (_req: express.Request, res: express.Response) => {
    try {
      // 远程样式源不可用时兜底空数组，避免前端加载应用中心报错。
      const response = await fetchWithRetry(CONFIG.APP_STYLES_URL, {
        method: 'GET',
        signal: AbortSignal.timeout(8000)
      })
      if (response.ok) {
        const json = await response.json()
        const styles = Array.isArray(json) ? json : json?.data
        return res
          .status(HTTP_STATUS.OK)
          .json(createSuccessResponse(Array.isArray(styles) ? styles : []))
      }
      res.status(HTTP_STATUS.OK).json(createSuccessResponse([]))
    } catch (error) {
      logger.error('Failed to get build styles', error)
      res.status(HTTP_STATUS.OK).json(createSuccessResponse([]))
    }
  })

  return router
}
