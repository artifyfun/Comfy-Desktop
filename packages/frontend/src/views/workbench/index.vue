<template>
  <div class="page-container" style="background: var(--wb-bg-base)">
    <div id="app" class="pb-20 min-h-screen flex flex-col">
      <AppHeader
        :first-nav-to="'/'"
        :first-nav-label="t('appCenter')"
        first-nav-icon="mr-2 fas fa-home"
      />

      <div
        class="flex flex-1 min-h-0 px-4 mx-auto mt-2 w-full max-w-[1600px] sm:px-6 lg:px-8 gap-4"
      >
        <!-- 左：会话侧栏 -->
        <SessionSidebar
          :sessions="sidebarSessions"
          :current-id="sessionId"
          :collapsed="sidebarCollapsed"
          :show-archived="showArchived"
          :archived-count="archivedCount"
          @select="selectSession"
          @new-session="newDialogOpen = true"
          @collapse="sidebarCollapsed = !sidebarCollapsed"
          @rename="onRename"
          @archive="(s) => setArchived(s, true)"
          @unarchive="(s) => setArchived(s, false)"
          @delete="onDelete"
          @update:show-archived="(v) => (showArchived = v)"
          @manage-presets="presetMgrOpen = true"
          @show-env="showEnvDialog"
        />

        <!-- 中：会话区 -->
        <section
          class="flex-1 min-w-0 flex flex-col h-[calc(100vh-160px)]"
          style="border: 1px solid var(--wb-stroke); border-radius: var(--wb-r-card)"
        >
          <!-- 会话头 -->
          <div
            class="flex items-center gap-2 px-4 h-12 border-b border-[var(--wb-stroke)] shrink-0"
          >
            <!-- 侧栏折叠时:展开入口收进本面板左上角（侧栏 0 宽,不再占位） -->
            <button
              v-if="sidebarCollapsed"
              class="w-7 h-7 rounded-lg text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-deep)] flex items-center justify-center transition shrink-0"
              :title="t('workbenchExpandSidebar')"
              @click="sidebarCollapsed = false"
            >
              <i class="fas fa-bars-staggered text-sm"></i>
            </button>
            <!-- 预设 chip：点击切换（dsh preset 模式） -->
            <a-dropdown :trigger="['click']">
              <button
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition"
                style="border: 1px solid var(--wb-stroke-strong)"
                :class="
                  sessionPreset
                    ? 'preset-chip-on text-[var(--wb-accent)]'
                    : 'text-[var(--wb-text-2)]'
                "
                :title="t('workbenchPresetSwitch')"
              >
                <i :class="sessionPreset ? presetIcon(sessionPreset) : 'fas fa-bolt'"></i>
                {{ sessionPreset ? presetName(sessionPreset) : t('workbenchPresetPick') }}
                <i class="fas fa-chevron-down text-[9px] opacity-60"></i>
              </button>
              <template #overlay>
                <a-menu @click="onPresetMenu">
                  <a-menu-item v-for="p in sortedPresets" :key="p.id">
                    <span class="flex items-center gap-2">
                      <i :class="presetIcon(p)" class="w-4 text-[var(--wb-accent)]"></i>
                      <span>{{ presetName(p) }}</span>
                      <i
                        v-if="currentSession?.presetId === p.id"
                        class="fas fa-check text-[var(--wb-accent)] ml-auto"
                      ></i>
                    </span>
                    <div
                      class="text-[11px] text-[var(--wb-text-2)] whitespace-normal leading-snug mt-0.5"
                    >
                      {{ p.description?.[lang] || p.description?.zh }}
                    </div>
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
            <div class="flex-1 text-white text-sm truncate font-medium">
              {{ currentSession?.title || t('workbench') }}
            </div>
            <!-- 复制调试信息：spec 提示词 + 模型原始输出(含思考) + PLAN + 校验 + 执行 -->
            <a-button
              size="small"
              :title="t('workbenchCopyDebug')"
              :disabled="!sessionId"
              @click="copyDebugInfo"
            >
              <i class="fas fa-bug"></i>
            </a-button>
            <a-button size="small" @click="panelOpen = !panelOpen">
              <i class="fas fa-table-columns"></i>
            </a-button>
          </div>

          <!-- 对话流（含执行卡内联） -->
          <div ref="messagesEl" class="flex-1 overflow-y-auto p-4 space-y-6">
            <div v-if="messages.length === 0" class="text-center text-[var(--wb-text-2)] mt-10">
              <i class="fas fa-wand-magic-sparkles text-4xl mb-3 opacity-40"></i>
              <p>{{ t('workbenchIntro') }}</p>
            </div>
            <template v-for="(m, i) in messages" :key="i">
              <div v-if="showDateDivider(i)" class="w-full pt-1 pb-2 text-center shrink-0">
                <span
                  class="text-[11px] text-[var(--wb-text-3)] bg-[var(--wb-bg-base)] rounded-full px-3 py-1"
                >
                  {{ dateDividerLabel(m.createdAt) }}
                </span>
              </div>
              <div class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
                <div class="max-w-[85%] space-y-1 group/msg">
                  <!-- 附件缩略图（用户消息） -->
                  <div v-if="m.attachments?.length" class="flex gap-1.5 flex-wrap justify-end">
                    <div
                      v-for="(a, j) in m.attachments"
                      :key="j"
                      class="w-12 h-12 rounded bg-[var(--wb-surface-deep)] border border-[var(--wb-stroke-strong)] flex items-center justify-center overflow-hidden"
                    >
                      <img
                        v-if="a.kind === 'image' && a._preview"
                        :src="a._preview"
                        class="w-full h-full object-cover"
                      />
                      <i v-else :class="kindIcon(a.kind)" class="text-[var(--wb-text-2)]"></i>
                    </div>
                  </div>
                  <!-- 产物缩略图（artifact 消息内联，点击 lightbox） -->
                  <div
                    v-if="m.kind === 'artifact' && m.outputFiles?.length"
                    class="flex gap-2 flex-wrap"
                  >
                    <div
                      v-for="(f, j) in m.outputFiles"
                      :key="j"
                      class="w-24 h-24 rounded-lg overflow-hidden bg-[var(--wb-surface-deep)] border border-[var(--wb-stroke-strong)] cursor-zoom-in hover:border-[var(--wb-accent)] transition flex items-center justify-center"
                      @click="lightboxFile = f"
                    >
                      <img :src="viewUrl(f)" class="w-full h-full object-cover" loading="lazy" />
                    </div>
                  </div>
                  <div
                    class="rounded-lg px-3 py-2 text-sm break-words"
                    :class="[
                      messageClass(m),
                      m.kind === 'chat' || m.kind === 'error' ? '' : 'whitespace-pre-wrap',
                    ]"
                  >
                    <template v-if="m.kind === 'card' && m.plan">
                      <div class="font-semibold mb-1">
                        <i class="fas fa-diagram-project mr-1"></i>{{ t('workbenchPlan') }}
                      </div>
                      <div class="text-xs opacity-80 mb-2">{{ m.plan.reason }}</div>
                      <div class="text-xs">{{ cardText(m.plan) }}</div>
                    </template>
                    <template v-else-if="m.kind === 'progress'">
                      <a-spin size="small" />
                      <span class="ml-2">{{ m.text }}</span>
                    </template>
                    <!-- codex 工具条目折叠行（执行中 spinner，完成后可展开详情） -->
                    <template v-else-if="m.kind === 'tool_item' && m.toolItem">
                      <div class="flex items-center gap-2 min-w-0" @click.stop="toggleToolItem(m)">
                        <a-spin v-if="toolItemRunning(m.toolItem)" size="small" />
                        <i
                          v-else
                          :class="`fas ${toolItemSummary(m.toolItem).icon} text-tech-cyan`"
                        ></i>
                        <span class="font-mono text-xs truncate flex-1">{{
                          toolItemSummary(m.toolItem).label
                        }}</span>
                        <i
                          v-if="toolItemDetail(m.toolItem)"
                          :class="`fas fa-chevron-${expandedToolIds.has(m.toolItem.id) ? 'down' : 'right'} text-[10px] opacity-60`"
                        ></i>
                      </div>
                      <pre
                        v-if="expandedToolIds.has(m.toolItem.id) && toolItemDetail(m.toolItem)"
                        class="mt-1.5 max-h-48 overflow-y-auto text-[11px] leading-relaxed rounded bg-black/40 border border-[var(--wb-stroke)] p-2 whitespace-pre-wrap break-all text-[var(--wb-text-2)] font-mono"
                        >{{ toolItemDetail(m.toolItem) }}</pre
                      >
                    </template>
                    <!-- agent 文本走 markdown（dsh 同款 marked+DOMPurify）；用户消息保持纯文本 -->
                    <WbMarkdown
                      v-else-if="(m.kind === 'chat' || m.kind === 'error') && m.role === 'agent'"
                      :source="m.text"
                    />
                    <template v-else>{{ m.text }}</template>
                  </div>
                  <!-- dsh 式操作行:hover 浮出,贴气泡下方 -->
                  <div
                    class="flex items-center gap-3 text-[11px] text-[var(--wb-text-3)] h-5 opacity-0 group-hover/msg:opacity-100 transition"
                    :class="m.role === 'user' ? 'justify-end pr-1' : 'pl-1'"
                  >
                    <button
                      v-if="copyableText(m)"
                      class="hover:text-slate-200 flex items-center gap-1"
                      :title="t('workbenchCopyMessage')"
                      @click="copyMessage(m, i)"
                    >
                      <i
                        :class="copiedIdx === i ? 'fas fa-check text-green-400' : 'far fa-copy'"
                      ></i>
                    </button>
                    <span class="text-slate-600">{{ timeLabel(m.createdAt) }}</span>
                    <!-- token 用量:仅该会话最后一轮 AI 回复显示(↑输入 ↓输出) -->
                    <span
                      v-if="usageFor(m)"
                      class="text-slate-600 tabular-nums"
                      :title="usageTitle(usageFor(m))"
                    >
                      <i class="fas fa-arrow-up text-[9px]"></i
                      >{{ fmtTokens(usageFor(m).inputTokens) }}
                      <i class="fas fa-arrow-down text-[9px] ml-1"></i
                      >{{ fmtTokens(usageFor(m).outputTokens) }}
                    </span>
                    <!-- 分支导航:该消息存在兄弟变体时显示 ‹ v/N › -->
                    <span v-if="m._variants > 1" class="flex items-center gap-1">
                      <button
                        class="hover:text-slate-200 px-0.5"
                        :disabled="m._variant <= 0"
                        :class="{ 'opacity-30 cursor-default': m._variant <= 0 }"
                        :title="t('workbenchPrevVariant')"
                        @click="switchVariant(m, -1)"
                      >
                        <i class="fas fa-chevron-left text-[9px]"></i>
                      </button>
                      <span class="tabular-nums">{{ m._variant + 1 }}/{{ m._variants }}</span>
                      <button
                        class="hover:text-slate-200 px-0.5"
                        :disabled="m._variant >= m._variants - 1"
                        :class="{ 'opacity-30 cursor-default': m._variant >= m._variants - 1 }"
                        :title="t('workbenchNextVariant')"
                        @click="switchVariant(m, 1)"
                      >
                        <i class="fas fa-chevron-right text-[9px]"></i>
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- invalid issues -->
          <div v-if="pendingIssues.length" class="px-4 pb-2">
            <a-alert type="warning" show-icon>
              <template #message>{{ t('workbenchPlanInvalid') }}</template>
              <template #description>
                <ul class="list-disc pl-4 text-xs">
                  <li v-for="(issue, i) in pendingIssues" :key="i">
                    {{ issue.field }}: {{ issue.message }}
                  </li>
                </ul>
              </template>
            </a-alert>
          </div>

          <!-- 富输入框 -->
          <Composer
            ref="composerEl"
            v-model="input"
            :busy="busy"
            :uploading="uploading"
            :attachments="draftAttachments"
            :skills="skills"
            :model-override="modelOverride"
            @send="send"
            @upload-files="uploadFiles"
            @reference-files="referenceLocalFiles"
            @remove-attachment="removeAttachment"
            @update:model-override="saveModelOverride"
          />
        </section>

        <!-- 右：产物面板（可折叠） -->
        <section
          v-if="panelOpen"
          class="w-72 shrink-0 flex flex-col h-[calc(100vh-160px)]"
          style="border: 1px solid var(--wb-stroke); border-radius: var(--wb-r-card)"
        >
          <div
            class="p-3 border-b border-[var(--wb-stroke)] text-white font-semibold flex items-center justify-between"
          >
            <span
              ><i class="fas fa-photo-film mr-2 text-[var(--wb-accent)]"></i
              >{{ t('workbenchArtifacts') }}</span
            >
          </div>
          <div class="flex-1 overflow-y-auto p-3 space-y-3">
            <div
              v-if="artifacts.length === 0"
              class="text-center text-[var(--wb-text-2)] mt-8 text-sm"
            >
              {{ t('workbenchNoArtifacts') }}
            </div>
            <div
              v-for="(a, i) in artifacts"
              :key="i"
              class="rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface-deep)] p-2"
            >
              <div class="flex items-center justify-between mb-1">
                <a-tag
                  :color="
                    a.status === 'success' ? 'green' : a.status === 'error' ? 'red' : 'processing'
                  "
                >
                  {{ a.status }}
                </a-tag>
                <span class="flex items-center gap-1 min-w-0">
                  <span class="text-xs text-[var(--wb-text-2)] truncate max-w-[140px]">{{
                    a.templateName
                  }}</span>
                  <!-- 复制执行 ID：排查/反馈时贴给 AI 或开发者 -->
                  <button
                    class="shrink-0 text-slate-500 hover:text-slate-200 text-xs px-1"
                    :title="t('workbenchCopyPromptId')"
                    @click="copyPromptId(a)"
                  >
                    <i class="far fa-copy"></i>
                  </button>
                </span>
              </div>
              <!-- 批量任务进度条 -->
              <div v-if="a.batchStatus && a.batchStatus !== 'completed'" class="mb-2">
                <div class="flex justify-between text-xs text-[var(--wb-text-2)] mb-1">
                  <span>{{ t('workbenchBatchProgress') }}</span>
                  <span
                    >{{ a.batchSuccess ?? 0 }}/{{ a.batchTotal ?? '?' }}（失败
                    {{ a.batchFailed ?? 0 }}）</span
                  >
                </div>
                <div class="h-1.5 rounded bg-[var(--wb-surface-hover)] overflow-hidden">
                  <div
                    class="h-full bg-[var(--wb-accent)] transition-all"
                    :style="{ width: (a.batchPercent ?? 0) + '%' }"
                  ></div>
                </div>
              </div>
              <!-- 产物缩略图网格（ComfyUI /view 直出，点击 lightbox） -->
              <div v-if="a.files?.length" class="grid grid-cols-3 gap-1 mb-1">
                <div
                  v-for="(f, j) in a.files"
                  :key="j"
                  class="group/file relative aspect-square rounded overflow-hidden bg-slate-900 border border-[var(--wb-stroke-strong)] cursor-zoom-in hover:border-[var(--wb-accent)] transition"
                  @click="lightboxFile = f"
                >
                  <img :src="viewUrl(f)" class="w-full h-full object-cover" loading="lazy" />
                  <!-- hover 操作:单入口「⋯」dropdown,避免平铺 -->
                  <a-dropdown
                    :trigger="['click']"
                    class="absolute right-1 top-1 hidden group-hover/file:block"
                  >
                    <button
                      class="w-6 h-6 flex items-center justify-center rounded bg-black/70 text-slate-200 hover:text-white"
                      :title="t('workbenchFileActions')"
                      @click.stop
                    >
                      <i class="fas fa-ellipsis-h text-xs"></i>
                    </button>
                    <template #overlay>
                      <a-menu @click="({ key }) => onFileAction(key, a, f)">
                        <a-menu-item key="save" v-if="isElectron">
                          <span class="flex items-center gap-2"
                            ><i class="fas fa-download w-4"></i>{{ t('workbenchSaveAs') }}</span
                          >
                        </a-menu-item>
                        <a-menu-item key="favorite">
                          <span class="flex items-center gap-2"
                            ><i class="fas fa-star w-4"></i>{{ t('workbenchFavorite') }}</span
                          >
                        </a-menu-item>
                        <a-menu-item key="publish" v-if="a.status === 'success'">
                          <span class="flex items-center gap-2"
                            ><i class="fas fa-bolt w-4"></i>{{ t('workbenchPublish') }}</span
                          >
                        </a-menu-item>
                        <a-menu-item key="open" v-if="isElectron">
                          <span class="flex items-center gap-2"
                            ><i class="fas fa-folder-open w-4"></i
                            >{{ t('workbenchOpenInFolder') }}</span
                          >
                        </a-menu-item>
                      </a-menu>
                    </template>
                  </a-dropdown>
                </div>
              </div>
              <div v-else-if="a.outputs.length" class="text-xs text-[var(--wb-text-2)] break-all">
                {{ a.outputs.join(' · ') }}
              </div>
              <!-- 执行失败：错误摘要 + 复制全文（完整错误在轮询回填的 a.error） -->
              <div
                v-if="a.status === 'error' && a.error"
                class="mt-2 flex items-center justify-between gap-2 rounded bg-red-500/10 border border-red-500/30 px-2 py-1.5"
              >
                <span class="text-xs text-red-300 truncate flex-1" :title="a.error">{{
                  a.error
                }}</span>
                <button
                  class="shrink-0 text-xs text-red-200 hover:text-white flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-red-500/20"
                  @click="copyArtifactError(a)"
                >
                  <i class="far fa-copy"></i>{{ t('workbenchCopyError') }}
                </button>
              </div>
              <!-- 卡级操作收敛到每文件 dropdown;此处仅保留批量终态徽标 -->
              <div
                v-if="a.batchStatus && ['completed', 'stopped', 'failed'].includes(a.batchStatus)"
                class="mt-2 text-xs text-[var(--wb-text-2)]"
              >
                {{ a.batchStatus }} · {{ a.batchSuccess ?? 0 }}/{{ a.batchTotal ?? '?' }}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 新建会话（预设 chip） -->
    <NewSessionDialog
      v-model:open="newDialogOpen"
      :presets="presets"
      :default-preset-id="defaultPresetId"
      @create="createSession"
    />

    <!-- 技能/预设管理 -->
    <PresetManager
      v-model:open="presetMgrOpen"
      :presets="presets"
      :default-id="defaultPresetId"
      @changed="loadPresets"
    />

    <!-- 工作台能力/环境说明（自我认知可视化） -->
    <a-modal v-model:open="envOpen" :title="t('workbenchEnvInfo')" :footer="null" width="560px">
      <div v-if="envLoading" class="py-8 text-center"><a-spin /></div>
      <div
        v-else-if="envSnapshot && envSnapshot.appNames && envSnapshot.modelsByType"
        class="space-y-3 py-2"
      >
        <div>
          <div class="text-xs text-[var(--wb-text-2)] mb-1">{{ t('workbenchEnvSkills') }}</div>
          <div class="flex flex-wrap gap-1.5">
            <a-tag v-for="n in envSnapshot.appNames" :key="n" color="blue">{{ n }}</a-tag>
            <span v-if="!envSnapshot.appNames.length" class="text-xs text-[var(--wb-text-3)]"
              >—</span
            >
          </div>
        </div>
        <div>
          <div class="text-xs text-[var(--wb-text-2)] mb-1">{{ t('workbenchEnvModels') }}</div>
          <div v-for="(names, type) in envSnapshot.modelsByType" :key="type" class="text-xs mb-1">
            <span class="text-tech-cyan font-mono">{{ type }}</span
            >：
            <span class="text-[var(--wb-text-2)]"
              >{{ names.slice(0, 12).join('、')
              }}{{ names.length > 12 ? ` 等 ${names.length} 个` : '' }}</span
            >
          </div>
          <div
            v-if="!Object.keys(envSnapshot.modelsByType).length"
            class="text-xs text-[var(--wb-text-3)]"
          >
            —（未配置 modelsDirs 或目录为空）
          </div>
        </div>
        <div class="flex gap-4 text-xs">
          <span class="text-[var(--wb-text-2)]"
            >{{ t('workbenchEnvVram') }}:
            <b class="text-white">{{
              envSnapshot.vramGb ? `约 ${Math.round(envSnapshot.vramGb)}GB` : '—'
            }}</b></span
          >
          <span class="text-[var(--wb-text-2)]"
            >{{ t('workbenchEnvNodes') }}:
            <b class="text-white">{{ envSnapshot.customNodes.length }}</b></span
          >
        </div>
        <a-collapse ghost>
          <a-collapse-panel
            key="nodes"
            :header="`${t('workbenchEnvNodes')} (${envSnapshot.customNodes.length})`"
          >
            <div class="text-xs text-[var(--wb-text-2)] break-all leading-relaxed">
              {{ envSnapshot.customNodes.join('、') || '—' }}
            </div>
          </a-collapse-panel>
        </a-collapse>
        <p
          class="text-xs text-[var(--wb-text-3)] leading-relaxed border-t border-[var(--wb-stroke)] pt-2"
        >
          {{ t('workbenchEnvHint') }}
        </p>
      </div>
      <div v-else-if="!envLoading" class="py-8 text-center text-xs text-[var(--wb-text-3)]">
        —（环境快照不可用）
      </div>
    </a-modal>

    <!-- Lightbox：产物大图/视频预览 -->
    <div
      v-if="lightboxFile"
      class="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center"
      @click="lightboxFile = null"
    >
      <video
        v-if="isVideoFile(lightboxFile)"
        :src="viewUrl(lightboxFile)"
        controls
        autoplay
        class="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
        @click.stop
      ></video>
      <img
        v-else
        :src="viewUrl(lightboxFile)"
        class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
      <button
        class="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white text-xl hover:bg-white/20 flex items-center justify-center"
        @click.stop="lightboxFile = null"
      >
        <i class="fas fa-xmark"></i>
      </button>
    </div>

    <!-- 归档/删除 确认弹窗（破坏性操作统一二次确认） -->
    <a-modal
      :open="!!confirmState"
      :title="
        confirmState?.kind === 'delete'
          ? t('workbenchDeleteConfirmTitle')
          : t('workbenchArchiveConfirmTitle')
      "
      :ok-text="confirmState?.kind === 'delete' ? t('delete') : t('workbenchArchive')"
      :cancel-text="t('cancel')"
      :ok-button-props="{ danger: confirmState?.kind === 'delete' }"
      @ok="onConfirmOk"
      @cancel="confirmState = null"
    >
      <p class="text-sm text-[var(--wb-text-2)]">
        {{
          confirmState?.kind === 'delete'
            ? t('workbenchDeleteConfirmBody', { title: confirmState?.session?.title || '' })
            : t('workbenchArchiveConfirmBody', { title: confirmState?.session?.title || '' })
        }}
      </p>
    </a-modal>

    <!-- 固化弹窗 -->
    <a-modal
      v-model:open="publishOpen"
      :title="t('workbenchPublishTitle')"
      @ok="doPublish"
      :ok-text="t('confirm')"
      :cancel-text="t('cancel')"
      :ok-button-props="{ loading: publishing }"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('appName')">
          <a-input
            v-model:value="publishName"
            :placeholder="t('workbenchPublishNamePlaceholder')"
            class="wb-tech-input"
          />
        </a-form-item>
        <a-form-item :label="t('workbenchPublishUi')">
          <a-switch v-model:checked="publishBuildUi" />
          <span class="ml-2 text-xs text-[var(--wb-text-2)]">{{
            t('workbenchPublishUiHint')
          }}</span>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import AppHeader from '@/views/apps/components/AppHeader.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import WbMarkdown from './components/WbMarkdown.vue'
import Composer from './components/Composer.vue'
import NewSessionDialog from './components/NewSessionDialog.vue'
import PresetManager from './components/PresetManager.vue'

const { t, getCurrentLanguage } = useI18n()
const appStore = useAppStore()
const route = useRoute()
const router = useRouter()

const origin = computed(() => appStore.config?.serverHost || window.location.origin)
const lang = computed(() => (getCurrentLanguage?.() === 'en' ? 'en' : 'zh'))

// ---------- 会话状态 ----------
const sessions = ref([])
const sessionId = ref('')
const messages = ref([])
const artifacts = ref([])
const pendingIssues = ref([])
const input = ref('')
const busy = ref(false)
const uploading = ref(false)
// 执行失败自动恢复：单会话最多自动重试 N 次（防死循环烧 token），切会话清零
const recoverCount = ref(0)
const recovering = ref(false)
const MAX_AUTO_RECOVERS = 2
// 单次执行占位气泡：promptId → messages 下标；poll 终态原位更新，避免
// 「已提交」「生成完成」「执行失败」各占一个气泡把对话流切碎
const execProgressIndex = new Map()
const draftAttachments = ref([])
const skills = ref([])
const presets = ref([])
const defaultPresetId = ref('standard')
const modelOverride = ref({})
const sidebarCollapsed = ref(false)
const showArchived = ref(false)
const confirmState = ref(null) // { kind:'archive'|'delete', session }
const panelOpen = ref(true)
const messagesEl = ref(null)
const composerEl = ref(null)
const pollTimers = new Map()
const newDialogOpen = ref(false)
const presetMgrOpen = ref(false)

const currentSession = computed(() => sessions.value.find((s) => s.id === sessionId.value))
const sessionPreset = computed(() =>
  currentSession.value?.presetId
    ? presets.value.find((p) => p.id === currentSession.value.presetId)
    : null,
)
const sidebarSessions = computed(() =>
  sessions.value.map((s) => ({
    ...s,
    _running: (s.executions ?? []).some((e) => e.status === 'queued' || e.status === 'running'),
  })),
)

// ---------- 初始化 ----------
onMounted(async () => {
  await Promise.all([loadSessions(), loadPresets(), loadSkills()])
  const sid = route.query.session
  if (sid && sessions.value.some((s) => s.id === sid)) {
    await selectSession({ id: sid })
  } else {
    await createSession({ presetId: defaultPresetId.value })
  }
  document.addEventListener('keydown', onGlobalKey)
})

onBeforeUnmount(() => {
  for (const timer of pollTimers.values()) clearInterval(timer)
  pollTimers.clear()
  document.removeEventListener('keydown', onGlobalKey)
})

function onGlobalKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault()
    newDialogOpen.value = true
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    // 聚焦输入框（对话主场景）
    e.preventDefault()
    composerEl.value?.querySelector('textarea')?.focus()
  }
}

async function loadSessions() {
  const res = await fetch(`${origin.value}/api/workbench/sessions?archived=${showArchived.value}`)
  const json = await res.json()
  sessions.value = json?.data ?? []
}

async function loadPresets() {
  const res = await fetch(`${origin.value}/api/workbench/presets`)
  const json = await res.json()
  presets.value = json?.data?.presets ?? []
  defaultPresetId.value = json?.data?.default ?? 'standard'
}

async function loadSkills() {
  const res = await fetch(`${origin.value}/api/workbench/skills`)
  const json = await res.json()
  skills.value = json?.data ?? []
}

async function selectSession(s) {
  sessionId.value = s.id
  toolItemIndex.clear() // 条目索引是 per-render 的，切会话必须清（防 upsert 错位）
  execProgressIndex.clear() // 执行占位下标同样 per-render，切会话清
  recoverCount.value = 0 // 恢复计数是会话级的，切会话清零
  recovering.value = false
  router.replace({ query: { session: s.id } })
  const res = await fetch(`${origin.value}/api/workbench/session/${s.id}`)
  const json = await res.json()
  if (!res.ok || !json?.success) return
  const session = json.data
  curSession.value = session
  messages.value = session.messages ?? []
  artifacts.value = [...(session.executions ?? [])].reverse().map((e) => ({
    promptId: e.promptId,
    templateId: e.templateId,
    templateName: e.templateId,
    status: e.status,
    error: e.error ?? '',
    outputs: (e.outputs ?? []).map((f) => (typeof f === 'string' ? f : f.filename)),
    // v2 outputs 为完整引用对象；旧数据字符串只有 filename（lightbox 降级直开）
    files: (e.outputs ?? []).filter((f) => typeof f === 'object'),
  }))
  modelOverride.value = session.modelOverride ?? {}
  pendingIssues.value = []
  for (const e of session.executions ?? []) {
    if (e.batchJobId && (e.status === 'queued' || e.status === 'running'))
      startBatchPoll(e.promptId)
    else if (e.status === 'queued' || e.status === 'running') startPoll(e.promptId)
  }
  scrollToBottom()
}

async function createSession({ presetId, title }) {
  const res = await fetch(`${origin.value}/api/workbench/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetId, title }),
  })
  const json = await res.json()
  await loadSessions()
  await selectSession({ id: json.data.id })
}

async function onRename({ id, title }) {
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title }),
  })
  await loadSessions()
}

// 归档走确认弹窗（dsh/Codex 惯例：破坏性视图操作需二次确认；单会话级操作）
function setArchived(s, archived) {
  if (!archived) return doSetArchived(s, false)
  const running = (s.executions ?? []).some((e) => e.status === 'queued' || e.status === 'running')
  if (!running) return doSetArchived(s, true)
  confirmState.value = { kind: 'archive', session: s }
}

async function onConfirmOk() {
  const st = confirmState.value
  confirmState.value = null
  if (!st) return
  if (st.kind === 'archive') await doSetArchived(st.session, true)
  else await doDelete(st.session)
}

async function doSetArchived(s, archived) {
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, archived }),
  })
  await loadSessions()
  if (sessionId.value === s.id && archived) {
    const first = sessions.value.find((x) => !x.archived)
    if (first) await selectSession(first)
  }
}

function onDelete(s) {
  confirmState.value = { kind: 'delete', session: s }
}

async function doDelete(s) {
  await fetch(`${origin.value}/api/workbench/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id }),
  })
  await loadSessions()
  if (sessionId.value === s.id) {
    const first = sessions.value[0]
    if (first) await selectSession(first)
    else await createSession({})
  }
}

async function saveModelOverride(v) {
  modelOverride.value = v
  if (!sessionId.value) return
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId.value, modelOverride: v }),
  })
}

// ---------- 附件 ----------
async function uploadFiles(files) {
  uploading.value = true
  for (const f of files) {
    const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null
    const kind = f.type.startsWith('image/')
      ? 'image'
      : f.type.startsWith('video/')
        ? 'video'
        : f.type.startsWith('audio/')
          ? 'audio'
          : 'file'
    if (kind === 'file') {
      // 文档类：不参与工作流媒体槽位（ComfyUI 不吃文档），仅作为 AI 决策上下文。
      // 明示给用户，避免"传了却没被用"的困惑。
      message.info(t('workbenchDocAsContext', { name: f.name }))
    }
    draftAttachments.value.push({
      kind,
      filename: f.name,
      size: f.size,
      mime: f.type,
      uploading: true,
      _preview: preview,
    })
    const idx = draftAttachments.value.length - 1
    try {
      const form = new FormData()
      form.append('file', f)
      const res = await fetch(`${origin.value}/api/workbench/upload`, {
        method: 'POST',
        body: form,
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.message || 'upload failed')
      Object.assign(draftAttachments.value[idx], json.data, { uploading: false })
    } catch (e) {
      message.error(`${f.name}: ${e.message}`)
      draftAttachments.value.splice(idx, 1)
    }
  }
  uploading.value = false
}

// B 权限:引用本地文件(不复制)。登记为附件,localPath 供执行链路同机直通;
// 上限 200MB 与上传一致。
function referenceLocalFiles(items) {
  for (const it of items) {
    if (it.size > 200 * 1024 * 1024) {
      message.error(`${it.filename}: 文件超过 200MB 上限`)
      continue
    }
    const ext = (it.filename.split('.').pop() || '').toLowerCase()
    const kind = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
      ? 'image'
      : ['mp4', 'webm', 'mov'].includes(ext)
        ? 'video'
        : ['mp3', 'wav', 'ogg', 'flac'].includes(ext)
          ? 'audio'
          : 'file'
    draftAttachments.value.push({
      kind,
      filename: it.filename,
      size: it.size,
      mime: '',
      localPath: it.path,
      uploading: false,
      _preview: kind === 'image' ? null : null,
    })
  }
}

function removeAttachment(i) {
  const a = draftAttachments.value[i]
  if (a?._preview) URL.revokeObjectURL(a._preview)
  draftAttachments.value.splice(i, 1)
}

function kindIcon(kind) {
  if (kind === 'video') return 'fas fa-film'
  if (kind === 'audio') return 'fas fa-music'
  if (kind === 'file') return 'fas fa-file'
  return 'fas fa-image'
}

// ---------- 发送 ----------
/**
 * 执行一轮 chat（decide → 校验 → 执行）。用户发送与「执行失败自动恢复」共用，
 * 避免恢复轮复制一份 SSE 消费逻辑。
 * @param inputText 发给后端 decide 的输入
 * @param attachments 附件元信息
 * @param opts.userBubble 用户气泡文案；null 时不 push 用户气泡（自动恢复场景）
 * @param opts.progressText deciding 占位气泡文案
 */
async function runChat(inputText, attachments, opts = {}) {
  busy.value = true
  pendingIssues.value = []
  if (opts.userBubble != null) {
    messages.value.push({
      role: 'user',
      kind: 'chat',
      text: opts.userBubble,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now(),
    })
  }
  messages.value.push({
    role: 'agent',
    kind: 'progress',
    text: opts.progressText ?? t('workbenchDeciding'),
    createdAt: Date.now(),
  })
  scrollToBottom()
  try {
    const res = await fetch(`${origin.value}/api/workbench/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId.value, input: inputText, attachments }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(j?.message || `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const part of parts) handleSse(part)
    }
  } catch (e) {
    dismissDecidingProgress()
    messages.value.push({
      role: 'agent',
      kind: 'error',
      text: e.message,
      createdAt: Date.now(),
    })
  } finally {
    busy.value = false
    scrollToBottom()
  }
}

/**
 * 执行失败自动恢复：把失败原因喂回 decide，让 AI 自行分析并继续（修复参数重试 /
 * 换模板 / 说明原因）。只对快路径（PLAN 直接执行）的单次执行生效——编排模式
 * （wb_execute_template）失败本就以工具结果回到模型，不需要此通道。单会话限
 * MAX_AUTO_RECOVERS 次，防死循环；恢复轮再次失败会继续递减余量。
 */
async function autoRecover(errorText) {
  if (recovering.value || busy.value || recoverCount.value >= MAX_AUTO_RECOVERS) return
  recoverCount.value++
  recovering.value = true
  try {
    const hint =
      `${t('workbenchAutoRecoverIntro')}\n\n` +
      `上次执行失败信息：${(errorText || '').slice(0, 800)}\n\n` +
      t('workbenchAutoRecoverAsk')
    await runChat(hint, [], {
      userBubble: null,
      progressText: t('workbenchAutoRecovering'),
    })
  } finally {
    recovering.value = false
  }
}

async function send() {
  const text = input.value.trim()
  const readyAttachments = draftAttachments.value.filter((a) => !a.uploading)
  // 文本或已上传附件至少其一即可发送（dsh 语义：附件可作为唯一输入）
  if ((!text && readyAttachments.length === 0) || busy.value) return
  const attachments = readyAttachments.map((a) => ({
    name: a.name,
    subfolder: a.subfolder,
    type: a.type,
    kind: a.kind,
    filename: a.filename,
    size: a.size,
    mime: a.mime,
    localPath: a.localPath,
  }))
  input.value = ''
  for (const a of draftAttachments.value) if (a._preview) URL.revokeObjectURL(a._preview)
  draftAttachments.value = []
  await runChat(text, attachments, { userBubble: text })
}

// ---------- codex 条目流转写（抄 codex app-server/dsh transcript：
// item.id → 消息行索引，started 占行，updated/completed 原位 upsert） ----------
const toolItemIndex = new Map()

function toolItemSummary(item) {
  switch (item.type) {
    case 'command_execution':
      return { icon: 'fa-terminal', label: item.command }
    case 'file_change':
      return {
        icon: 'fa-file-pen',
        label: (item.changes || []).map((c) => c.path).join(', ') || 'file change',
      }
    case 'mcp_tool_call':
      return { icon: 'fa-plug', label: `${item.server}/${item.tool}` }
    case 'web_search':
      return { icon: 'fa-magnifying-glass', label: item.query || 'web search' }
    case 'reasoning':
      return { icon: 'fa-brain', label: (item.text || '').slice(0, 80) }
    case 'todo_list':
      return { icon: 'fa-list-check', label: 'todo' }
    case 'error':
      return { icon: 'fa-triangle-exclamation', label: item.message || 'error' }
    default:
      return { icon: 'fa-circle-dot', label: item.type }
  }
}

const expandedToolIds = reactive(new Set())

function toggleToolItem(m) {
  const id = m.toolItem?.id
  if (!id || !toolItemDetail(m.toolItem)) return
  if (expandedToolIds.has(id)) expandedToolIds.delete(id)
  else expandedToolIds.add(id)
}

function toolItemRunning(item) {
  // 各 item 的 in-flight 状态字段统一收口
  return (
    item.status === 'in_progress' ||
    item.status === 'inProgress' ||
    (item.type === 'command_execution' && item.exit_code === undefined) ||
    false
  )
}

function toolItemDetail(item) {
  switch (item.type) {
    case 'command_execution':
      return item.aggregated_output || null
    case 'file_change':
      return (item.changes || []).map((c) => `${c.kind || 'update'}: ${c.path}`).join('\n') || null
    case 'mcp_tool_call':
      return item.result
        ? JSON.stringify(item.result, null, 1)
        : JSON.stringify(item.arguments ?? {}, null, 1)
    case 'reasoning':
      return item.text && item.text.length > 80 ? item.text : null
    default:
      return null
  }
}

/**
 * codex 内部噪音条目：网络重连 / 元数据降级 / /v1/responses 路由探测失败等。
 * 这些只是 SDK 的自我修复过程，对用户没有信息量，不占对话行（完整原始输出
 * 仍在「复制调试信息」里）。避免一次对话出现 5-8 条红色报错行，观感像断线。
 */
function isNoisyItem(item) {
  if (item?.type !== 'error') return false
  const m = item.message || ''
  return (
    /reconnecting/i.test(m) ||
    /falling back from websockets/i.test(m) ||
    /model metadata for/i.test(m) ||
    /no route for (GET|POST) \/v1\/responses/i.test(m)
  )
}

function handleThreadItem(evt) {
  if (!evt || typeof evt !== 'object') return
  const phase = evt.type // started | updated | completed
  const item = evt.item
  if (!item || !item.id) return
  // PLAN 原文（agent_message）由 plan 事件渲染为执行计划卡，不重复占行
  if (item.type === 'agent_message') return
  // codex 内部重连/降级噪音不占行
  if (isNoisyItem(item)) return
  if (phase === 'started' && !toolItemIndex.has(item.id)) {
    messages.value.push({
      role: 'agent',
      kind: 'tool_item',
      text: '',
      toolItem: item,
      createdAt: Date.now(),
    })
    toolItemIndex.set(item.id, messages.value.length - 1)
    return
  }
  const idx = toolItemIndex.get(item.id)
  if (idx === undefined) {
    // 错过 started（如重连）——直接补一行
    messages.value.push({
      role: 'agent',
      kind: 'tool_item',
      text: '',
      toolItem: item,
      createdAt: Date.now(),
    })
    toolItemIndex.set(item.id, messages.value.length - 1)
    return
  }
  // 原位更新（Vue3 响应式数组元素替换）
  messages.value[idx] = { ...messages.value[idx], toolItem: item }
}

/**
 * 移除 AI 占位进度气泡（「AI 正在决策…」/「执行失败，AI 正在分析…」）。
 * 不能只 pop 尾部：decide 阶段的过程条目（tool_item）追加在占位之后，占位
 * 可能已不在数组末尾，尾部 pop 会漏掉它，导致 loading 气泡残留/错位。
 */
function dismissDecidingProgress() {
  const placeholders = [t('workbenchDeciding'), t('workbenchAutoRecovering')]
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m.kind === 'progress' && placeholders.includes(m.text)) {
      messages.value.splice(i, 1)
    }
  }
}

function handleSse(chunk) {
  let event = 'message'
  let data = null
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6))
      } catch {
        data = { raw: line.slice(6) }
      }
    }
  }
  if (event === 'item') {
    // 过程条目（reasoning / command / file_change 等）只是 decide 的实时过程，
    // 不打断「AI 正在决策…」loading——否则条目一出现 loading 就消失，而 decide
    // 可能还要几十秒才出结论，观感像断了。条目行追加在 loading 气泡之后。
    handleThreadItem(data.event)
    return
  }
  // 决定性/阶段事件（plan/reply/stage/submitted/error/invalid/done）才替换占位。
  dismissDecidingProgress()
  if (event === 'reply') {
    messages.value.push({
      role: 'agent',
      kind: 'chat',
      text: data.reply || '',
      createdAt: Date.now(),
    })
  } else if (event === 'plan') {
    messages.value.push({
      role: 'agent',
      kind: 'card',
      text: '',
      plan: data.plan,
      createdAt: Date.now(),
    })
  } else if (event === 'stage') {
    messages.value.push({
      role: 'agent',
      kind: 'progress',
      text: stageText(data.stage),
      createdAt: Date.now(),
    })
  } else if (event === 'submitted') {
    // 收掉「校验中/提交中」等 stage 进度
    const lp = messages.value[messages.value.length - 1]
    if (lp && lp.kind === 'progress') messages.value.pop()
    artifacts.value.unshift({
      promptId: data.promptId,
      templateId: data.templateId,
      templateName: data.templateId,
      status: 'running',
      error: '',
      outputs: [],
      files: [],
    })
    if (data.batch?.jobId) {
      // 批量：不额外占气泡，入队文案由服务端 reply 事件带出（产物卡有进度条）
      startBatchPoll(data.batch.jobId)
    } else {
      // 单次执行：一个「执行中」占位气泡，poll 终态原位更新成结果，
      // 避免「已提交到队列」「生成完成」「执行失败」各占一个气泡
      messages.value.push({
        role: 'agent',
        kind: 'progress',
        text: t('workbenchExecuting'),
        createdAt: Date.now(),
      })
      execProgressIndex.set(data.promptId, messages.value.length - 1)
      startPoll(data.promptId)
    }
  } else if (event === 'invalid') {
    pendingIssues.value = data.issues ?? []
    messages.value.push({
      role: 'agent',
      kind: 'error',
      text: t('workbenchPlanInvalid') + ': ' + (data.issues ?? []).map((i) => i.message).join('；'),
      createdAt: Date.now(),
    })
  } else if (event === 'error') {
    messages.value.push({
      role: 'agent',
      kind: 'error',
      text: data.message || 'error',
      createdAt: Date.now(),
    })
  } else if (event === 'done') {
    // 会话摘要 → 侧栏刷新（标题可能被自动生成更新）
    if (data.session) {
      const s = sessions.value.find((x) => x.id === data.session.id)
      if (s) {
        s.title = data.session.title
        s.updatedAt = data.session.updatedAt
      } else {
        loadSessions()
      }
    }
  }
}

function stageText(stage) {
  const map = {
    deciding: t('workbenchDeciding'),
    validating: t('workbenchValidating'),
    executing: t('workbenchExecuting'),
  }
  return map[stage] ?? stage
}

// 批量任务轮询:进度/产物经 batch API 汇入产物卡(同一张卡,进度条展示)
function startBatchPoll(promptId) {
  const poll = async () => {
    try {
      const res = await fetch(`${origin.value}/api/batch/status?id=${encodeURIComponent(promptId)}`)
      const json = await res.json()
      const job = json?.data?.job ?? json?.data
      if (!job) return
      const artifact = artifacts.value.find((a) => a.promptId === promptId)
      if (!artifact) {
        stopBatchPoll(promptId)
        return
      }
      artifact.batchStatus = job.status
      artifact.batchPercent = job.percent
      artifact.batchSuccess = job.success
      artifact.batchFailed = job.failed
      artifact.batchTotal = job.total
      const doneFiles = (job.results ?? [])
        .filter((r) => r.success && r.files)
        .flatMap((r) => r.files)
      if (doneFiles.length) {
        artifact.files = doneFiles
        artifact.outputs = doneFiles.map((f) => f.filename)
      }
      if (['completed', 'stopped', 'failed'].includes(job.status)) {
        artifact.status = job.status === 'completed' ? 'success' : 'error'
        messages.value.push({
          role: 'agent',
          kind: job.status === 'completed' ? 'chat' : 'error',
          text:
            job.status === 'completed'
              ? t('workbenchBatchDone', { total: job.total, success: job.success })
              : `${t('workbenchFailed')}: 批量任务 ${job.status}`,
          createdAt: Date.now(),
        })
        scrollToBottom()
        stopBatchPoll(promptId)
      }
    } catch {
      /* 下轮重试 */
    }
  }
  poll()
  pollTimers.set(`batch:${promptId}`, setInterval(poll, 2500))
}

function stopBatchPoll(promptId) {
  const t = pollTimers.get(`batch:${promptId}`)
  if (t) clearInterval(t)
  pollTimers.delete(`batch:${promptId}`)
}

function startPoll(promptId) {
  const poll = async () => {
    try {
      const res = await fetch(`${origin.value}/api/workbench/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.value, promptId }),
      })
      const json = await res.json()
      const r = json?.data
      if (!r) return
      const artifact = artifacts.value.find((a) => a.promptId === promptId)
      if (artifact) {
        artifact.status = r.status
        if (r.status === 'error') artifact.error = (r.error || '').slice(0, 2000)
        if (r.status === 'success' && r.outputs) {
          artifact.outputs = extractFiles(r.outputs).map((f) => f.filename)
          artifact.files = extractFiles(r.outputs)
        }
      }
      if (r.status === 'success' || r.status === 'error') {
        // 原位更新执行占位气泡为最终结果；找不到（重进会话/切会话后恢复轮询）
        // 时兜底 push 新气泡
        const execIdx = execProgressIndex.get(promptId)
        execProgressIndex.delete(promptId)
        if (execIdx !== undefined && messages.value[execIdx]) {
          messages.value[execIdx] =
            r.status === 'success'
              ? { ...messages.value[execIdx], kind: 'chat', text: t('workbenchDone') }
              : {
                  ...messages.value[execIdx],
                  kind: 'error',
                  text: `${t('workbenchFailed')}: ${(r.error || '').slice(0, 300)}`,
                }
        } else {
          messages.value.push({
            role: 'agent',
            kind: r.status === 'success' ? 'chat' : 'error',
            text:
              r.status === 'success'
                ? t('workbenchDone')
                : `${t('workbenchFailed')}: ${(r.error || '').slice(0, 300)}`,
            createdAt: Date.now(),
          })
        }
        scrollToBottom()
        stopPoll(promptId)
        // 快路径执行失败：自动发起恢复轮（限次防死循环），让 AI 分析原因并继续
        if (r.status === 'error') void autoRecover(r.error || '')
        loadSessions().then(() => {
          const s = sessions.value.find((x) => x.id === sessionId.value)
          const exec = s?.executions?.find((e) => e.promptId === promptId)
          if (exec) {
            const art = artifacts.value.find((a) => a.promptId === promptId)
            if (art) {
              art.outputs = (exec.outputs ?? []).map((f) =>
                typeof f === 'string' ? f : f.filename,
              )
              art.files = (exec.outputs ?? []).filter((f) => typeof f === 'object')
            }
          }
        })
      }
    } catch {
      /* 下轮重试 */
    }
  }
  pollTimers.set(promptId, setInterval(poll, 3000))
}

function stopPoll(promptId) {
  const timer = pollTimers.get(promptId)
  if (timer) {
    clearInterval(timer)
    pollTimers.delete(promptId)
  }
}

function extractFiles(outputs) {
  // v2：保留完整引用（filename+subfolder+type），/view 直出缩略图
  const files = []
  for (const v of Object.values(outputs || {})) {
    const o = v || {}
    for (const key of ['images', 'gifs']) {
      for (const it of o[key] ?? []) {
        if (it.filename)
          files.push({ filename: it.filename, subfolder: it.subfolder, type: it.type })
      }
    }
  }
  return files
}

const comfyOrigin = computed(() => appStore.config?.comfyHost || 'http://127.0.0.1:8188')
const lightboxFile = ref(null)

// 每文件操作 dropdown 分发
function onFileAction(key, artifact, f) {
  if (key === 'save') saveArtifactAs(f)
  else if (key === 'favorite') favoriteArtifact(artifact, f)
  else if (key === 'publish') openPublish(artifact)
  else if (key === 'open') openInFolder(artifact, f)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('workbenchCopied'))
  } catch (e) {
    message.error(String(e?.message || e))
  }
}

/** 复制执行失败错误全文（对话气泡只截断 500 字符，产物卡保存完整 2000 字符） */
async function copyArtifactError(a) {
  await copyText(a.error || '')
}

/** 复制执行 ID：反馈/排查时把卡片信息贴给 AI 或开发者 */
async function copyPromptId(a) {
  await copyText(a.promptId || '')
}

/** 把一轮调试快照格式化为可读文本（markdown 风格，粘贴后可直接贴给开发者） */
function formatDebugLog(log) {
  const planJson = JSON.stringify(log.plan ?? null, null, 2)
  const lines = [
    `# 工作台调试信息（第 ${log.seq} 轮）`,
    `时间：${new Date(log.ts).toLocaleString()}`,
    `模型：${log.model || '（默认）'}`,
    '',
    '## 决策输入',
    log.effectiveInput || '（空）',
    log.presetId ? `预设：${log.presetId}` : '',
    log.templateShortcut ? `模板快捷方式：${log.templateShortcut}` : '',
    '',
    '## 决策提示词（spec，前端不可见）',
    log.spec || '（空）',
    '',
    '## 模型原始输出（raw，含思考过程）',
    log.rawOutput || '（空）',
    '',
    '## 解析后的 PLAN',
    planJson,
    '',
    '## 校验问题',
    log.issues?.length ? log.issues.map((i) => `- [${i.field}] ${i.message}`).join('\n') : '（无）',
    log.remoteIssues?.length
      ? '远端校验：\n' + log.remoteIssues.map((i) => `- [${i.field}] ${i.message}`).join('\n')
      : '',
    '',
    '## 执行',
    `promptId: ${log.promptId || '（未执行）'}`,
    `templateId: ${log.templateId || '—'}`,
    `status: ${log.executionStatus || '—'}`,
    log.executionError ? `error: ${log.executionError}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

/** 复制最近一轮完整调试信息（服务端记录的 decide 快照） */
async function copyDebugInfo() {
  if (!sessionId.value) {
    message.warning(t('workbenchNoSession'))
    return
  }
  try {
    const res = await fetch(
      `${origin.value}/api/workbench/debug/last?sessionId=${encodeURIComponent(sessionId.value)}`,
    )
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(j?.message || `HTTP ${res.status}`)
    }
    const json = await res.json()
    const log = json?.data
    if (!log) {
      message.warning(t('workbenchNoDebugLog'))
      return
    }
    await copyText(formatDebugLog(log))
  } catch (e) {
    message.error(String(e?.message || e))
  }
}

// 在系统文件管理器中定位产物(同机 ComfyUI)
async function openInFolder(artifact, f) {
  try {
    const outDir = outputDirInfo.value?.outputDir
    if (!outDir) {
      message.warning(t('workbenchSaveAsUnavailable'))
      return
    }
    const api = window.electronAPI?.ArtifyLab
    const full = `${outDir}/${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`
    if (api?.revealInFolder) await api.revealInFolder({ path: full })
    else if (api?.openPath) await api.openPath(full)
    else message.info(full)
  } catch (e) {
    message.error(String(e?.message || e))
  }
}

// 收藏产物:跨会话收藏夹,缩略图区星星按钮
async function favoriteArtifact(artifact, f) {
  try {
    const res = await fetch(`${origin.value}/api/workbench/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId.value, promptId: artifact.promptId, file: f }),
    })
    const json = await res.json()
    if (json?.ok) message.success(t('workbenchFavorited'))
    else message.error(json?.message || 'favorite failed')
  } catch (e) {
    message.error(String(e?.message || e))
  }
}

// A 权限:产物另存为(系统保存对话框)。仅同机 ComfyUI(settings.outputDir)可用;
// sourcePath 校验在主进程侧(白名单 outputDir/inputDir)。
async function saveArtifactAs(f) {
  try {
    const outDir = outputDirInfo.value?.outputDir
    const sourcePath = outDir
      ? `${outDir}/${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`
      : null
    if (!sourcePath) {
      message.warning(t('workbenchSaveAsUnavailable'))
      return
    }
    const r = await window.electronAPI.ArtifyLab.saveArtifact({
      sourcePath,
      suggestedName: f.filename,
    })
    if (r?.ok) message.success(t('workbenchSavedTo') + r.savedTo)
    else if (r?.error !== 'canceled') message.error(r?.error || 'save failed')
  } catch (e) {
    message.error(String(e?.message || e))
  }
}

// 同机 ComfyUI 的产物磁盘根(/view 只能给 URL,另存为需要真实路径)
const outputDirInfo = ref(null)
async function loadOutputDir() {
  try {
    const res = await fetch(`${origin.value}/api/workbench/runtime`)
    const json = await res.json()
    outputDirInfo.value = json?.data ?? null
  } catch {}
}

function viewUrl(f) {
  return `${comfyOrigin.value}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`
}

function isVideoFile(f) {
  return /\.(mp4|webm|mov|gif)$/i.test(f?.filename ?? '')
}

// ---------- 固化 ----------
const publishOpen = ref(false)
const publishName = ref('')
const publishBuildUi = ref(true)
const publishing = ref(false)
const publishTarget = ref(null)

function openPublish(artifact) {
  publishTarget.value = artifact
  publishName.value = `App ${new Date().toLocaleString()}`
  publishOpen.value = true
}

async function doPublish() {
  if (!publishTarget.value || !publishName.value.trim()) return
  publishing.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId.value,
        promptId: publishTarget.value.promptId,
        name: publishName.value.trim(),
        buildUi: publishBuildUi.value,
      }),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'publish failed')
    publishOpen.value = false
    messages.value.push({
      role: 'agent',
      kind: 'chat',
      text: t('workbenchPublished'),
      createdAt: Date.now(),
    })
    router.push('/')
  } catch (e) {
    message.error(e.message)
  } finally {
    publishing.value = false
  }
}

function presetName(p) {
  return p?.name?.[lang.value] || p?.name?.zh || p?.id
}

// ---------- 能力/环境说明（自我认知可视化） ----------
const envOpen = ref(false)
const envLoading = ref(false)
const envSnapshot = ref(null)

async function showEnvDialog() {
  envOpen.value = true
  envLoading.value = true
  envSnapshot.value = null
  try {
    // 能力/环境快照走 /env（appNames/modelsByType/vramGb/customNodes）。
    // 勿改回 /runtime：那上面只有 outputDir（另存为白名单用），拿到后
    // 模板访问缺失字段会渲染崩，弹窗卡在 loading。
    const res = await fetch(`${origin.value}/api/workbench/env`)
    const json = await res.json()
    envSnapshot.value = json?.data ?? null
  } catch {
    envSnapshot.value = null
  } finally {
    envLoading.value = false
  }
}

// dsh order 语义：预设列表按 order 升序
const sortedPresets = computed(() =>
  [...presets.value].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
)

function presetIcon(p) {
  if (p?.intentHint === 'video') return 'fas fa-film'
  if (p?.intentHint === 'image') return 'fas fa-image'
  return 'fas fa-bolt'
}

// 预设点击切换（dsh 模式）：会话级 presetId 立即生效
async function onPresetMenu({ key }) {
  if (!sessionId.value || sessionId.value === key) return
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId.value, presetId: key }),
  })
  await loadSessions()
  // 本地会话对象同步（selectSession 会重新拉详情）
  const s = sessions.value.find((x) => x.id === sessionId.value)
  if (s) Object.assign(currentSession.value ?? {}, { presetId: key })
}

function messageClass(m) {
  if (m.role === 'user')
    return 'bg-[var(--wb-surface-deep)] text-white border-l-[3px] border-l-[var(--wb-accent)]'
  if (m.kind === 'error') return 'bg-red-900/60 text-red-200'
  if (m.kind === 'card')
    return 'bg-[var(--wb-surface-deep)] text-slate-200 border border-[var(--wb-stroke-strong)]'
  return 'bg-[var(--wb-surface-deep)] text-slate-200 border-l-[3px] border-l-[var(--wb-stroke-strong)]'
}

// ---------- token 用量展示 ----------
const curSession = ref(null)

function usageFor(m) {
  if (m.kind !== 'chat' || m.role !== 'agent') return null
  const u = curSession.value?.turnUsages ?? []
  return u.length ? u[u.length - 1] : null
}

function usageTitle(u) {
  return `输入 ${u.inputTokens}（缓存 ${u.cachedInputTokens}）· 输出 ${u.outputTokens}（思考 ${u.reasoningOutputTokens}）`
}

function fmtTokens(n) {
  if (n >= 10000) return (n / 1000).toFixed(0) + 'k'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// ---------- 日期分隔与时间标签（dsh 同款） ----------
function sameDay(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return false
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

function showDateDivider(i) {
  if (i === 0) return true
  return !sameDay(messages.value[i - 1].createdAt, messages.value[i].createdAt)
}

function dateDividerLabel(ts) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (sameDay(ts, now)) return t('today')
  if (sameDay(ts, yest)) return t('yesterday')
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function timeLabel(ts) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------- 会话分支（dsh ‹ n/N › 语义） ----------
async function switchVariant(m, delta) {
  const target = m._variant + delta
  if (target < 0 || target >= m._variants) return
  // 分叉父的下标按存储序:当前消息的 parentId 就是分叉父的 _idx
  const parentIdx = m._idx !== undefined ? (m.parentId ?? -1) : -1
  if (parentIdx < 0) return
  const res = await fetch(`${origin.value}/api/workbench/session/${sessionId.value}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageIdx: parentIdx, variant: target }),
  })
  if (!res.ok) return
  await selectSession({ id: sessionId.value })
}

// ---------- 气泡复制 ----------
const copiedIdx = ref(-1)
let copiedTimer = null

/** 该气泡的可复制数据:文本取原文,card/artifact 取结构化摘要,tool_item 取详情 */
function copyableText(m) {
  if (m.kind === 'progress') return ''
  if (m.kind === 'tool_item') return m.toolItem ? JSON.stringify(m.toolItem, null, 2) : ''
  if (m.kind === 'card' && m.plan) return JSON.stringify(m.plan, null, 2)
  if (m.kind === 'artifact')
    return [m.text, ...(m.outputFiles ?? []).map((f) => f.filename)].filter(Boolean).join('\n')
  return m.text || ''
}

async function copyMessage(m, i) {
  const text = copyableText(m)
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 非 https/权限拒绝兜底:隐藏 textarea 方案
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copiedIdx.value = i
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copiedIdx.value = -1), 1500)
}

function cardText(plan) {
  if (!plan) return ''
  const p = plan.params ?? {}
  const ps = Object.entries(p)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join('，')
  return `${plan.intent} · ${plan.templateId ?? ''}${ps ? ' · ' + ps : ''}`
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

// 归档徽章计数独立于当前过滤视图
const allCounts = ref({ total: 0, archived: 0 })
async function loadArchiveCount() {
  try {
    const res = await fetch(`${origin.value}/api/workbench/sessions`)
    const json = await res.json()
    const list = json?.data ?? []
    allCounts.value = { total: list.length, archived: list.filter((x) => x.archived).length }
  } catch {}
}
const archivedCount = computed(() => allCounts.value.archived)
watch(showArchived, () => {
  loadSessions()
  loadArchiveCount()
})
onMounted(() => {
  loadArchiveCount()
  loadOutputDir()
})
</script>

<style>
/* 工作台全局小样式（modal 传送 body，需非 scoped） */
@import './workbench.css';
</style>
