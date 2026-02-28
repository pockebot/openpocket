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
        OpenPocket runs an always-on agent phone locally, with privacy first.
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
  <div class="op-why-grid">
    <div class="op-why-item">
      <h3>Local Runtime</h3>
      <p>Execute mobile workflows on your own machine. No expensive cloud subscriptions, no data leaks.</p>
    </div>
    <div class="op-why-item">
      <h3>Human + Agent</h3>
      <p>The perfect hybrid. Manual control when you want it, agent automation when you don't.</p>
    </div>
    <div class="op-why-item">
      <h3>Auditable &amp; Private</h3>
      <p>All sessions and memory stay visible and local. Your data, your rules.</p>
    </div>
  </div>
</section>

<!-- OpenPocket Tagline -->
<section class="op-tagline">
  <p class="op-section-desc"><img class="op-desc-logo" :src="withBase('/openpocket-logo.png')" alt="" /><span class="op-desc-brand">OpenPocket</span> helps users automate real mobile app tasks,<br/><span class="op-underline-dotted">without</span> sending execution control to a cloud phone runtime.</p>
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

<!-- Architecture -->
<section class="op-arch">
  <p class="op-section-label">Architecture Behind OpenPocket</p>
  <div class="op-arch-with-video">
    <div class="op-arch-simple op-arch-group">
      <div class="op-arch-flow op-arch-flow--vertical">
        <div class="op-arch-node op-arch-node--gray">User</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--blue">Gateway</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--orange">Agent Runtime</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--blue">ADB Runtime</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--gray">Agent Phone Target</div>
      </div>
      <div class="op-arch-flow op-arch-flow--branch op-arch-flow--vertical">
        <div class="op-arch-node op-arch-node--blue">Gateway</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--blue">Auth Relay</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--orange">Agent Runtime</div>
        <span class="op-arch-arrow op-arch-arrow--down">↓</span>
        <div class="op-arch-node op-arch-node--gray">User Interface</div>
      </div>
    </div>
    <div class="op-arch-video">
      <video autoplay muted playsinline :src="withBase('/hamster-architecture.mp4')" @ended="onVideoEnd"></video>
    </div>
  </div>
</section>

</div>
