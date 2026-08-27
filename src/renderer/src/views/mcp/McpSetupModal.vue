<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ExternalLink, Eye, EyeOff, X } from 'lucide-vue-next'
import { emitTelemetryAction } from '../../lib/telemetry'
import BaseModal from '../../components/ui/BaseModal.vue'
import BaseCopyButton from '../../components/ui/BaseCopyButton.vue'
import type { McpConfigInfo } from '../../types/ipc'

const emit = defineEmits<{
  close: []
}>()

/**
 * Artify 内嵌 MCP 的配置弹窗（接管自官方 comfy-mcp 分发界面）。
 *
 * 数据来自主进程同进程直读（desktop2-get-mcp-config IPC）：
 * endpoint / token / 已暴露的 app 工具数。每个 A UI app 都是一个
 * `run__<id>` MCP 工具，app 增删后工具列表自动同步。
 */
const config = ref<McpConfigInfo | null>(null)
const loadError = ref('')

onMounted(async () => {
  try {
    const info = await window.api?.getMcpConfig?.()
    if (info) {
      config.value = info
    } else {
      loadError.value = 'Embedded MCP server is not available right now.'
    }
  } catch {
    loadError.value = 'Failed to load MCP connection info.'
  }
})

const showToken = ref(false)

const maskedToken = computed(() => {
  const token = config.value?.token
  if (!token) return ''
  return showToken.value ? token : `${token.slice(0, 4)}${'•'.repeat(16)}`
})

interface Snippet {
  key: string
  label: string
  cmd: string
}

const snippets = computed<Snippet[]>(() => {
  const url = config.value?.url ?? ''
  const token = config.value?.token ?? ''
  return [
    {
      key: 'claude',
      label: 'Claude Code (CLI)',
      cmd: `claude mcp add --transport http artify ${url} --header "Authorization: Bearer ${token}"`
    },
    {
      key: 'json',
      label: 'Cursor / Claude Desktop (JSON)',
      cmd: JSON.stringify(
        { mcpServers: { artify: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2
      )
    },
    { key: 'generic', label: 'Generic (URL + token)', cmd: `URL: ${url}\nToken: ${token}` }
  ]
})

/** `icon` is the agent's simple-icons monochrome path (24x24 viewBox). */
const AGENTS = [
  {
    label: 'Claude Code',
    href: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    icon: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
  },
  {
    label: 'Cursor',
    href: 'https://docs.cursor.com/get-started/installation',
    icon: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23'
  },
  {
    label: 'Codex',
    href: 'https://developers.openai.com/codex/cli',
    icon: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'
  }
]

function trackCopy(client: string): void {
  emitTelemetryAction('comfy.desktop.mcp.snippet_copied', { client })
}
</script>

<template>
  <BaseModal
    :open="true"
    aria-label="Connect an agent with Artify MCP"
    :show-close-button="false"
    blur-overlay
    content-class="mcp-modal-panel"
    @close="emit('close')"
  >
    <div class="mcp-modal">
      <section class="mcp-panel">
        <button class="mcp-close" aria-label="Close" @click="emit('close')">
          <X :size="16" />
        </button>

        <header class="mcp-head">
          <h2 class="mcp-title">Connect an agent via MCP</h2>
          <p class="mcp-lead">
            Every app you build in Artify is exposed as an MCP tool. Point your AI agent at the
            embedded server below — no extra install needed.
          </p>
        </header>

        <div v-if="loadError" class="mcp-error">{{ loadError }}</div>

        <template v-else-if="config">
          <div v-if="!config.loopback" class="mcp-warn">
            The server is listening on {{ config.listenHost }} (non-loopback): the MCP endpoint is
            reachable from your network. Keep the token safe.
          </div>

          <div class="mcp-field">
            <span class="mcp-field__label">Endpoint</span>
            <div class="mcp-cmd">
              <code class="mcp-cmd__text">{{ config.url }}</code>
              <BaseCopyButton
                :value="config.url"
                :size="14"
                aria-label="Copy endpoint URL"
                class="mcp-cmd__copy"
                @click="trackCopy('endpoint')"
              />
            </div>
          </div>

          <div class="mcp-field">
            <span class="mcp-field__label">Token</span>
            <div class="mcp-cmd">
              <code class="mcp-cmd__text">{{ maskedToken }}</code>
              <button
                class="mcp-token__toggle"
                :aria-label="showToken ? 'Hide token' : 'Show token'"
                @click="showToken = !showToken"
              >
                <EyeOff v-if="showToken" :size="14" />
                <Eye v-else :size="14" />
              </button>
              <BaseCopyButton
                :value="config.token"
                :size="14"
                aria-label="Copy token"
                class="mcp-cmd__copy"
                @click="trackCopy('token')"
              />
            </div>
          </div>

          <div class="mcp-field">
            <span class="mcp-field__label">Client setup</span>
            <div class="mcp-steps">
              <div v-for="snippet in snippets" :key="snippet.key" class="mcp-snippet">
                <span class="mcp-snippet__label">{{ snippet.label }}</span>
                <div class="mcp-cmd">
                  <pre class="mcp-cmd__pre">{{ snippet.cmd }}</pre>
                  <BaseCopyButton
                    :value="snippet.cmd"
                    :size="14"
                    :aria-label="`Copy ${snippet.label} config`"
                    class="mcp-cmd__copy"
                    @click="trackCopy(snippet.key)"
                  />
                </div>
              </div>
            </div>
          </div>

          <p class="mcp-note">
            <strong>{{ config.appCount }}</strong> app{{ config.appCount === 1 ? '' : 's' }}
            currently exposed as tools. Creating or deleting apps updates the tool list
            automatically — no restart needed.
          </p>
        </template>

        <div v-else class="mcp-note">Loading connection info…</div>

        <footer class="mcp-actions">
          <span class="mcp-actions__hint">Need an agent?</span>
          <a
            v-for="agent in AGENTS"
            :key="agent.label"
            class="mcp-agent"
            :href="agent.href"
            target="_blank"
            rel="noreferrer"
          >
            <svg class="mcp-agent__logo" viewBox="0 0 24 24" aria-hidden="true">
              <path :d="agent.icon" />
            </svg>
            <span>{{ agent.label }}</span>
            <ExternalLink :size="12" />
          </a>
        </footer>
      </section>
    </div>
  </BaseModal>
</template>

<style scoped>
:global(.base-modal-panel.mcp-modal-panel) {
  width: min(100%, 620px);
  max-width: min(100%, 620px);
  min-height: 0;
  max-height: min(720px, calc(100vh - 64px));
}
:global(.mcp-modal-panel .base-modal-body) {
  padding: 0;
  overflow: hidden;
}

.mcp-modal {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text);
  font-family: var(--font-sans);
}

.mcp-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding: 32px 32px 24px;
  overflow: auto;
}

.mcp-close {
  position: absolute;
  top: 18px;
  right: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 14%, transparent);
  border-radius: 999px;
  cursor: pointer;
  background: color-mix(in oklab, var(--neutral-100) 6%, transparent);
  color: color-mix(in oklab, var(--neutral-100) 80%, transparent);
  transition:
    background 140ms ease,
    color 140ms ease;
}
.mcp-close:hover {
  background: color-mix(in oklab, var(--neutral-100) 8%, transparent);
  color: var(--text);
}
.mcp-close svg {
  flex: none;
}

.mcp-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 32px;
}
.mcp-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  line-height: 1.18;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.mcp-lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: color-mix(in oklab, var(--text) 68%, transparent);
}

.mcp-error,
.mcp-warn {
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.5;
}
.mcp-error {
  background: color-mix(in oklab, #f87171 12%, transparent);
  color: #f87171;
}
.mcp-warn {
  background: color-mix(in oklab, #fbbf24 12%, transparent);
  color: #fbbf24;
}

.mcp-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.mcp-field__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: color-mix(in oklab, var(--text) 55%, transparent);
}

.mcp-cmd {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 14%, transparent);
  border-radius: 10px;
  background: color-mix(in oklab, var(--neutral-100) 5%, transparent);
}
.mcp-cmd__text,
.mcp-cmd__pre {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}
.mcp-cmd__copy {
  flex: none;
}
.mcp-token__toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  background: transparent;
  color: color-mix(in oklab, var(--text) 60%, transparent);
  transition:
    background 120ms ease,
    color 120ms ease;
}
.mcp-token__toggle:hover {
  background: color-mix(in oklab, var(--neutral-100) 8%, transparent);
  color: var(--text);
}

.mcp-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mcp-snippet__label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: color-mix(in oklab, var(--text) 62%, transparent);
}

.mcp-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: color-mix(in oklab, var(--text) 60%, transparent);
}

.mcp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 12%, transparent);
}
.mcp-actions__hint {
  font-size: 12.5px;
  color: color-mix(in oklab, var(--text) 55%, transparent);
}
.mcp-agent {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: color-mix(in oklab, var(--text) 75%, transparent);
  text-decoration: none;
  transition: color 120ms ease;
}
.mcp-agent:hover {
  color: var(--text);
}
.mcp-agent__logo {
  width: 14px;
  height: 14px;
  fill: currentColor;
}
</style>
