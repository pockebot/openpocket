<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import { watch, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vitepress";

const { Layout } = DefaultTheme;
const route = useRoute();

function initScrollAnimations() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  nextTick(() => {
    const targets = document.querySelectorAll(
      ".op-hero-left, .op-hero-right, .op-why, .op-why-item, .op-bento, .op-usecases, .op-workflow, .op-workflow-step, .op-support, .op-support-item, .op-footer-animation"
    );

    if (!targets.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    targets.forEach((el) => {
      el.classList.remove("visible");
      observer.observe(el);
    });
  });
}

watch(
  () => route.path,
  () => { initScrollAnimations(); },
  { immediate: true }
);

function isHomePage() {
  if (typeof document === "undefined") {
    return false;
  }

  return !!document.querySelector(".op-landing");
}

/* ── Custom cursor ── */
const cursorEl = ref<HTMLDivElement | null>(null);
let customCursorEnabled = false;

function supportsCustomCursor() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches && window.innerWidth > 860;
}

function refreshCustomCursorState() {
  const el = cursorEl.value;
  if (!el) return;

  customCursorEnabled = isHomePage() && supportsCustomCursor();
  if (!customCursorEnabled) {
    el.classList.remove("visible", "hover");
    document.documentElement.classList.remove("has-custom-cursor");
    return;
  }

  document.documentElement.classList.add("has-custom-cursor");
}

function initCustomCursor() {
  const el = cursorEl.value;
  if (!el) return;
  refreshCustomCursorState();
  if (customCursorEnabled) {
    el.classList.add("visible");
  }
}

function updateCursor(e: MouseEvent) {
  if (!customCursorEnabled) return;
  const el = cursorEl.value;
  if (!el) return;
  el.style.left = e.clientX + "px";
  el.style.top = e.clientY + "px";

  const target = e.target as HTMLElement;
  if (target?.closest("a, button, [role='button'], .op-btn, input, .VPNavBarMenuLink")) {
    el.classList.add("hover");
  } else {
    el.classList.remove("hover");
  }
}

function hideCursor() {
  if (!customCursorEnabled) return;
  const el = cursorEl.value;
  if (el) el.classList.remove("visible");
}

function showCursor() {
  if (!customCursorEnabled) return;
  const el = cursorEl.value;
  if (el && isHomePage()) el.classList.add("visible");
}

/* ── Dot-grid background ── */
const dotCanvas = ref<HTMLCanvasElement | null>(null);
let animId = 0;
let cursorX = -9999;
let cursorY = -9999;
let dirty = true;

const GAP = 32;
const RADIUS = 2;
const RANGE = 120;

function initDotGrid() {
  const canvas = dotCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  cancelAnimationFrame(animId);

  if (!isHomePage()) {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "block";

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas!.width = window.innerWidth * dpr;
    canvas!.height = window.innerHeight * dpr;
    canvas!.style.width = window.innerWidth + "px";
    canvas!.style.height = window.innerHeight + "px";
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  function draw() {
    if (!dirty) { animId = requestAnimationFrame(draw); return; }
    dirty = false;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrollY = window.scrollY;
    ctx!.clearRect(0, 0, vw, vh);

    const dark = document.documentElement.classList.contains("dark");
    const baseA = dark ? 0.12 : 0.14;
    const hoverA = dark ? 0.50 : 0.40;

    const startRow = Math.floor(scrollY / GAP);
    const endRow = Math.ceil((scrollY + vh) / GAP);
    const cols = Math.ceil(vw / GAP) + 1;

    for (let r = startRow; r <= endRow; r++) {
      const screenY = r * GAP - scrollY;
      for (let c = 0; c <= cols; c++) {
        const screenX = c * GAP;
        const dx = screenX - cursorX;
        const dy = screenY - cursorY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let a = baseA;
        if (dist < RANGE) {
          const t = 1 - dist / RANGE;
          a = baseA + (hoverA - baseA) * t * t;
        }

        ctx!.beginPath();
        ctx!.arc(screenX, screenY, RADIUS, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(255,138,0,${a})`;
        ctx!.fill();
      }
    }

    animId = requestAnimationFrame(draw);
  }

  draw();
}

function onMove(e: MouseEvent) {
  if (!customCursorEnabled) return;
  cursorX = e.clientX;
  cursorY = e.clientY;
  dirty = true;
  updateCursor(e);
}

function onScroll() { dirty = true; }

function onResize() {
  refreshCustomCursorState();
  dirty = true;
}

function onLeave() {
  cursorX = -9999; cursorY = -9999; dirty = true;
  hideCursor();
}

function onEnter() { showCursor(); }

onMounted(() => {
  nextTick(() => {
    initDotGrid();
    initCustomCursor();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("mouseenter", onEnter);
  });
});

onUnmounted(() => {
  cancelAnimationFrame(animId);
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("scroll", onScroll);
  document.removeEventListener("mouseleave", onLeave);
  document.removeEventListener("mouseenter", onEnter);
  document.documentElement.classList.remove("has-custom-cursor");
});

watch(() => route.path, () => {
  nextTick(() => {
    initDotGrid();
    initCustomCursor();
  });
});
</script>

<template>
  <Layout>
    <template #layout-top>
      <canvas ref="dotCanvas" class="op-dot-grid" />
      <div ref="cursorEl" class="op-cursor" />
    </template>
  </Layout>
</template>
