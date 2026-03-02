---
layout: home

title: OpenPocket | An Intelligent Phone That Never Sleeps
titleTemplate: false
---

<script setup>
import { withBase } from "vitepress";

function onVideoEnd(e) {
  const video = e.target;
  setTimeout(() => {
    video.currentTime = 0;
    video.play();
  }, 600);
}
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

<!-- Use Cases -->
<section class="op-usecases">
  <p class="op-section-label">Use Cases</p>
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
      <div class="op-model-grid">
        <img class="op-model-logo" :src="withBase('/models/gpt-5.2-codex.svg')" alt="gpt-5.2-codex" title="gpt-5.2-codex" />
        <img class="op-model-logo" :src="withBase('/models/gpt-5.3-codex.svg')" alt="gpt-5.3-codex" title="gpt-5.3-codex" />
        <img class="op-model-logo" :src="withBase('/models/claude-sonnet-4.6.svg')" alt="claude-sonnet-4.6" title="claude-sonnet-4.6" />
        <img class="op-model-logo" :src="withBase('/models/claude-opus-4.6.svg')" alt="claude-opus-4.6" title="claude-opus-4.6" />
        <img class="op-model-logo" :src="withBase('/models/blockrun-gpt-4o.svg')" alt="blockrun/gpt-4o" title="blockrun/gpt-4o" />
        <img class="op-model-logo" :src="withBase('/models/blockrun-claude-sonnet-4.svg')" alt="blockrun/claude-sonnet-4" title="blockrun/claude-sonnet-4" />
        <img class="op-model-logo" :src="withBase('/models/blockrun-gemini-2.0-flash.svg')" alt="blockrun/gemini-2.0-flash" title="blockrun/gemini-2.0-flash" />
        <img class="op-model-logo" :src="withBase('/models/blockrun-deepseek-chat.svg')" alt="blockrun/deepseek-chat" title="blockrun/deepseek-chat" />
        <img class="op-model-logo" :src="withBase('/models/autoglm-phone.svg')" alt="autoglm-phone" title="autoglm-phone" />
      </div>
    </article>
  </div>
</section>

<!-- Footer Animation -->
<section class="op-footer-animation">
  <video autoplay muted playsinline preload="auto" :src="withBase('/hamster-architecture.mp4')" @ended="onVideoEnd"></video>
</section>

</div>
