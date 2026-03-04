---
layout: home

title: OpenPocket | An Intelligent Phone That Never Sleeps
titleTemplate: false
---

<script setup>
import { computed, ref } from "vue";
import { withBase } from "vitepress";

function onVideoEnd(e) {
  const video = e.target;
  setTimeout(() => {
    video.currentTime = 0;
    video.play();
  }, 600);
}

const modelSupport = [
  { id: "gpt-5.2-codex", provider: "OpenAI", model: "GPT-5.2 Codex", logo: "/models/openai.svg" },
  { id: "gpt-5.3-codex", provider: "OpenAI", model: "GPT-5.3 Codex", logo: "/models/openai.svg" },
  { id: "claude-sonnet-4.6", provider: "OpenRouter", model: "Claude Sonnet 4.6", logo: "/models/anthropic.svg" },
  { id: "claude-opus-4.6", provider: "OpenRouter", model: "Claude Opus 4.6", logo: "/models/anthropic.svg" },
  { id: "blockrun/gpt-4o", provider: "Blockrun", model: "GPT-4o", logo: "/models/openai.svg" },
  { id: "blockrun/claude-sonnet-4", provider: "Blockrun", model: "Claude Sonnet 4", logo: "/models/anthropic.svg" },
  { id: "blockrun/gemini-2.0-flash", provider: "Blockrun", model: "Gemini 2.0 Flash", logo: "/models/gemini.svg" },
  { id: "google/gemini-2.0-flash", provider: "Google AI Studio", model: "Gemini 2.0 Flash", logo: "/models/gemini.svg" },
  { id: "google/gemini-3-pro-preview", provider: "Google AI Studio", model: "Gemini 3 Pro Preview", logo: "/models/gemini.svg" },
  { id: "google/gemini-3.1-pro-preview", provider: "Google AI Studio", model: "Gemini 3.1 Pro Preview", logo: "/models/gemini.svg" },
  { id: "blockrun/deepseek-chat", provider: "Blockrun", model: "DeepSeek Chat", logo: "/models/deepseek.svg" },
  { id: "zai/glm-5", provider: "Z.AI (GLM)", model: "GLM-5", logo: "/models/zai.svg" },
  { id: "zai/glm-4.7", provider: "Z.AI (GLM)", model: "GLM-4.7", logo: "/models/zai.svg" },
  { id: "zai/glm-4.7-flash", provider: "Z.AI (GLM)", model: "GLM-4.7 Flash", logo: "/models/zai.svg" },
  { id: "kimi-k2-turbo-preview", provider: "Moonshot AI", model: "Kimi K2 Turbo Preview", logo: "/models/moonshot.svg" },
  { id: "kimi-k2.5", provider: "Moonshot AI", model: "Kimi K2.5", logo: "/models/moonshot.svg" },
  { id: "kimi-k2-thinking", provider: "Moonshot AI", model: "Kimi K2 Thinking", logo: "/models/moonshot.svg" },
  { id: "kimi-coding/k2p5", provider: "Kimi Code", model: "K2.5 (Coding)", logo: "/models/kimi.svg" },
  { id: "kimi-k2-thinking-turbo", provider: "Moonshot AI", model: "Kimi K2 Thinking Turbo", logo: "/models/moonshot.svg" },
  { id: "deepseek-v3", provider: "DeepSeek", model: "DeepSeek V3", logo: "/models/deepseek.svg" },
  { id: "deepseek-r1", provider: "DeepSeek", model: "DeepSeek R1", logo: "/models/deepseek.svg" },
  { id: "qwen-max", provider: "Qwen (DashScope)", model: "Qwen Max", logo: "/models/qwen.svg" },
  { id: "qwen-plus", provider: "Qwen (DashScope)", model: "Qwen Plus", logo: "/models/qwen.svg" },
  { id: "qwen-coder-plus", provider: "Qwen (DashScope)", model: "Qwen Coder Plus", logo: "/models/qwen.svg" },
  { id: "minimax-m2.5", provider: "MiniMax", model: "MiniMax M2.5", logo: "/models/minimax.svg" },
  { id: "minimax-m2.1", provider: "MiniMax", model: "MiniMax M2.1", logo: "/models/minimax.svg" },
  { id: "volcengine/doubao-seed-1-8", provider: "Volcano Engine", model: "Doubao Seed 1.8", logo: "/models/doubao.svg" },
  { id: "volcengine/deepseek-v3-2", provider: "Volcano Engine", model: "DeepSeek V3.2", logo: "/models/deepseek.svg" },
];

const modelSupportCollapsedCount = 9;
const showAllModels = ref(false);
const visibleModelSupport = computed(() =>
  showAllModels.value ? modelSupport : modelSupport.slice(0, modelSupportCollapsedCount),
);
const hasMoreModels = computed(() => modelSupport.length > modelSupportCollapsedCount);
</script>

<div class="op-landing">

<!-- Hero -->
<section class="op-hero">
  <div class="op-hero-left">
    <div class="op-hero-title-block">
      <h1 class="op-hero-title">
        <span class="regular">An</span> <span class="regular">Intelligent</span> <span class="orange">Phone</span><br/>
        <span class="regular">That Never Sleeps</span>
      </h1>
      <p class="op-hero-desc">
        OpenPocket is an open source phone use agent framework that runs locally, with privacy first.
      </p>
    </div>
    <div class="op-hero-npm">
      <p class="op-hero-npm-label">Install with NPM</p>
      <code class="op-hero-npm-code">npm install -g openpocket</code>
    </div>
    <div class="op-hero-actions">
      <a class="op-btn op-btn-brand" :href="withBase('/get-started/')">
        Start Setup
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M3.333 8h9.334"/><path d="M8 3.333 12.667 8 8 12.667"/></svg>
      </a>
      <a class="op-btn op-btn-alt" :href="withBase('/hubs')">Read Docs</a>
    </div>
  </div>
  <div class="op-hero-right">
    <video autoplay muted playsinline preload="auto" :src="withBase('/hamster-cover.mp4') + '?v=2'" @ended="onVideoEnd"></video>
  </div>
</section>

<!-- Use Cases (Bento Grid) -->
<section class="op-bento">
  <p class="op-section-label">Use Cases</p>
  <div class="op-bento-grid">
    <!-- Item 1 (was 4.mp4) -->
    <div class="op-bento-item">
      <video class="op-bento-video" autoplay muted loop playsinline src="https://kg6otgbdad5zepkn.public.blob.vercel-storage.com/4.mp4"></video>
      <div class="op-bento-overlay">
        <span class="op-bento-tag">Social</span>
        <h3 class="op-bento-title">Social</h3>
      </div>
      <div class="op-bento-log">> Checking emails...
> Draft reply: Meeting confirmed
> Calendar updated</div>
    </div>
    <!-- Item 2 -->
    <div class="op-bento-item">
      <video class="op-bento-video" autoplay muted loop playsinline src="https://kg6otgbdad5zepkn.public.blob.vercel-storage.com/2.mp4"></video>
      <div class="op-bento-overlay">
        <span class="op-bento-tag">Gaming</span>
        <h3 class="op-bento-title">Gaming</h3>
      </div>
      <div class="op-bento-log">> Scanning feed...
> Liked post #4829
> Commenting: "Great shot!"</div>
    </div>
    <!-- Item 3 -->
    <div class="op-bento-item">
      <video class="op-bento-video" autoplay muted loop playsinline src="https://kg6otgbdad5zepkn.public.blob.vercel-storage.com/3.mp4"></video>
      <div class="op-bento-overlay">
        <span class="op-bento-tag">Utility</span>
        <h3 class="op-bento-title">Utility Payment</h3>
      </div>
      <div class="op-bento-log">> Filtering content...
> Skipping ads (3s)
> Saving to Watch Later</div>
    </div>
    <!-- Item 4 (was 1.mp4) -->
    <div class="op-bento-item">
      <video class="op-bento-video" autoplay muted loop playsinline src="https://kg6otgbdad5zepkn.public.blob.vercel-storage.com/1.mp4"></video>
      <div class="op-bento-overlay">
        <span class="op-bento-tag">Education</span>
        <h3 class="op-bento-title">Studying</h3>
      </div>
      <div class="op-bento-log">> Identifying product...
> Price comparison: -15% found
> Adding to cart...</div>
    </div>
  </div>
</section>

<!-- Why OpenPocket? -->
<section class="op-why">
  <p class="op-section-label">Why OpenPocket?</p>
  <div class="op-why-list">
    <article class="op-why-item">
      <h3>Permission Isolation</h3>
      <p><strong>Human Phone and Agent Phone are fully isolated.</strong> The agent runs on a local sandbox target and has <strong>no direct access</strong> to your personal phone. Any sensitive step requires <strong>human authorization</strong> through remote approval.</p>
    </article>
    <article class="op-why-item">
      <h3>Local-First Privacy</h3>
      <p><strong>All sensitive data stays local</strong>, including accounts, credentials, runtime state, and Agent Phone artifacts. The authorization relay server also runs <strong>on your own machine</strong>, so private traffic remains inside your environment.</p>
    </article>
    <article class="op-why-item">
      <h3>Open Framework</h3>
      <p>OpenPocket follows extension-friendly standards and supports fast integration through <strong>one <code>SKILL.md</code></strong>. Developers can migrate from <strong>Mobile App to Agent App</strong> without changing existing app code.</p>
    </article>
  </div>
</section>

<!-- Scenarios (Scrolling Icons) -->
<section class="op-usecases">
  <p class="op-section-label">More Scenarios</p>
  <div class="op-usecases-scroll-wrap">
    <div class="op-usecases-track">
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-shopping.png')" alt="Shopping" /><span>Shopping</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-social.png')" alt="Social" /><span>Social</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-entertainment.png')" alt="Entertainment" /><span>Entertainment</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-andmore.png')" alt="And More" /><span>And More</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-shopping.png')" alt="Shopping" /><span>Shopping</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-social.png')" alt="Social" /><span>Social</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-entertainment.png')" alt="Entertainment" /><span>Entertainment</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-andmore.png')" alt="And More" /><span>And More</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-shopping.png')" alt="Shopping" /><span>Shopping</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-social.png')" alt="Social" /><span>Social</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-entertainment.png')" alt="Entertainment" /><span>Entertainment</span></a>
      <a class="op-usecase-card" :href="withBase('/concepts/project-blueprint') + '#user-scenarios'"><img class="op-usecase-icon" :src="withBase('/usecase-andmore.png')" alt="And More" /><span>And More</span></a>
    </div>
    <div class="op-usecases-fade-l"></div>
    <div class="op-usecases-fade-r"></div>
  </div>
</section>

<!-- Simple Workflow -->
<section class="op-workflow">
  <p class="op-section-label">Simple Workflow, Powerful Results</p>
  <div class="op-workflow-grid">
    <div class="op-workflow-step">
      <div class="op-workflow-step-header">
        <p class="op-workflow-step-num">1</p>
        <h3 class="op-workflow-step-title">Ask</h3>
      </div>
      <p>Initiate via CLI, local panel, or custom bot.</p>
    </div>
    <div class="op-workflow-step">
      <div class="op-workflow-step-header">
        <p class="op-workflow-step-num">2</p>
        <h3 class="op-workflow-step-title">Plan</h3>
      </div>
      <p>Agent chooses the next mobile action.</p>
    </div>
    <div class="op-workflow-step">
      <div class="op-workflow-step-header">
        <p class="op-workflow-step-num">3</p>
        <h3 class="op-workflow-step-title">Act</h3>
      </div>
      <p>OpenPocket executes on your local Agent Phone target.</p>
    </div>
  </div>
</section>

<!-- Support -->
<section class="op-support">
  <p class="op-section-label">Support</p>
  <div class="op-support-list">
    <article class="op-support-item">
      <h3>Phone Environment</h3>
      <div class="op-support-content">
        <span class="op-support-pill">Android</span>
        <span class="op-support-pill op-support-pill-soon">iOS (Coming Soon)</span>
      </div>
    </article>
    <article class="op-support-item">
      <h3>Agent Runtime</h3>
      <div class="op-support-content">
        <span class="op-support-pill">macOS</span>
        <span class="op-support-pill">Windows</span>
        <span class="op-support-pill">Linux</span>
      </div>
    </article>
    <article class="op-support-item">
      <h3>Model Support</h3>
      <div class="op-model-panel">
        <div class="op-model-grid">
          <article class="op-model-card" v-for="item in visibleModelSupport" :key="item.id">
            <div class="op-model-logo-box">
              <img
                class="op-model-logo"
                :src="withBase(item.logo)"
                :alt="`${item.provider} logo for ${item.model}`"
                :title="`${item.provider} / ${item.model}`"
              />
            </div>
            <div class="op-model-meta">
              <p class="op-model-provider">{{ item.provider }}</p>
              <p class="op-model-name">{{ item.model }}</p>
            </div>
          </article>
        </div>
        <button
          v-if="hasMoreModels"
          class="op-model-toggle"
          :class="{ 'is-expanded': showAllModels }"
          type="button"
          :aria-expanded="showAllModels ? 'true' : 'false'"
          @click="showAllModels = !showAllModels"
        >
          <span>{{ showAllModels ? "Show Less" : `Show All (${modelSupport.length})` }}</span>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="m3.333 6 4.667 4.667L12.667 6" />
          </svg>
        </button>
      </div>
    </article>
  </div>
</section>

<!-- Footer Animation -->
<section class="op-footer-animation">
  <video autoplay muted playsinline preload="auto" :src="withBase('/hamster-architecture.mp4')" @ended="onVideoEnd"></video>
</section>

</div>
