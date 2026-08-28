<template>
  <div class="page-container">
    <div class="container">
      <div class="header">
        <h1>{{ t('aiPaintingWorkflowPlatform') }}</h1>
        <p class="subtitle">{{ t('exploreAICreationPossibilities') }}</p>
      </div>
      <button class="btn pulse" @click="handleToggleAboutModal">
        <i class="fas fa-qrcode"></i> {{ t('followOfficialAccountForWorkflows') }}
      </button>
    </div>

    <About v-if="state.showAboutModal" @clickClose="handleToggleAboutModal" />
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import About from '@/components/About/index.vue'
import { t } from '@/utils/i18n'

const state = reactive({
  showAboutModal: false,
})

const handleToggleAboutModal = () => {
  state.showAboutModal = !state.showAboutModal
}
</script>

<style lang="less" scoped>
.page-container {
  font-family: var(--wb-font);
  background: var(--wb-bg-base);
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  color: var(--wb-text);
  padding: 20px;

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  .container {
    max-width: 1000px;
    text-align: center;
  }

  .header {
    margin-bottom: 40px;
  }

  h1 {
    font-size: 3.5rem;
    color: var(--wb-text);
    margin-bottom: 20px;
    letter-spacing: 2px;
  }

  .subtitle {
    font-size: 1.2rem;
    color: var(--wb-text-2);
    max-width: 600px;
    margin: 0 auto;
    line-height: 1.6;
  }

  .btn {
    background: var(--wb-accent);
    color: white;
    border: none;
    padding: 15px 40px;
    font-size: 1.2rem;
    border-radius: var(--wb-r-ctrl);
    cursor: pointer;
    margin-top: 30px;
    transition: background 0.15s ease;
    position: relative;
    overflow: hidden;
    letter-spacing: 1px;
    font-weight: 600;
  }

  .btn:hover {
    background: var(--wb-accent-hover);
  }
}
</style>
