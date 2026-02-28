import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsBaseRaw = process.env.DOCS_BASE?.trim() ?? "/";
const docsBase = docsBaseRaw.startsWith("/") ? docsBaseRaw : `/${docsBaseRaw}`;
const normalizedBase = docsBase.endsWith("/") ? docsBase : `${docsBase}/`;
const docsRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const homepageTitle = "OpenPocket | An Intelligent Phone That Never Sleeps";
const siteTitle = "OpenPocket";
const siteDescription =
  "Run AI phone-use automation locally with Android Emulator, auditable logs, and human-in-the-loop control.";
const siteKeywords = [
  "OpenPocket",
  "AI phone agent",
  "phone-use agent",
  "Android automation",
  "Android emulator automation",
  "local AI agent",
  "human in the loop automation",
  "Telegram phone bot",
  "mobile workflow automation",
  "privacy-first automation",
].join(", ");
const defaultSiteUrl = "https://www.openpocket.ai";
const assetVersion = process.env.DOCS_ASSET_VERSION?.trim() || "20260221";

function normalizeSiteUrl(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function withDocsBase(assetPath) {
  const cleaned = assetPath.replace(/^\/+/, "");
  return `${normalizedBase}${cleaned}`;
}

function withAssetVersion(assetPath) {
  const separator = assetPath.includes("?") ? "&" : "?";
  return `${assetPath}${separator}v=${encodeURIComponent(assetVersion)}`;
}

function toAbsoluteUrl(siteUrl, pathname) {
  if (!siteUrl) {
    return "";
  }

  const cleaned = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${siteUrl}${cleaned}`;
}

const rawSiteUrl =
  process.env.DOCS_SITE_URL?.trim() ||
  process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
  process.env.VERCEL_URL?.trim() ||
  defaultSiteUrl;
const siteUrl = normalizeSiteUrl(rawSiteUrl);
const faviconPath = withAssetVersion(withDocsBase("/openpocket-logo.png"));
const canonicalPath = normalizedBase;
const canonicalUrl = toAbsoluteUrl(siteUrl, canonicalPath);
const twitterSite = process.env.DOCS_TWITTER_SITE?.trim() ?? "";
const twitterCreator = process.env.DOCS_TWITTER_CREATOR?.trim() ?? "";
const siteHead = [
  ["link", { rel: "icon", href: faviconPath, type: "image/png", sizes: "64x64" }],
  ["link", { rel: "shortcut icon", href: faviconPath, type: "image/png" }],
  ["link", { rel: "canonical", href: canonicalUrl }],
  ["meta", { name: "application-name", content: siteTitle }],
  ["meta", { name: "apple-mobile-web-app-title", content: siteTitle }],
  ["meta", { name: "theme-color", content: "#ff8a00" }],
  ["meta", { name: "robots", content: "index, follow" }],
  [
    "meta",
    {
      name: "googlebot",
      content: "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1",
    },
  ],
  [
    "meta",
    {
      name: "keywords",
      content: siteKeywords,
    },
  ],
  ["meta", { property: "og:type", content: "website" }],
  ["meta", { property: "og:site_name", content: siteTitle }],
  ["meta", { property: "og:locale", content: "en_US" }],
  ["meta", { property: "og:title", content: homepageTitle }],
  ["meta", { property: "og:description", content: siteDescription }],
  ["meta", { property: "og:url", content: canonicalUrl }],
  ["meta", { name: "twitter:card", content: "summary" }],
  ["meta", { name: "twitter:title", content: homepageTitle }],
  ["meta", { name: "twitter:description", content: siteDescription }],
  ["meta", { name: "twitter:url", content: canonicalUrl }],
];
if (twitterSite) {
  siteHead.push(["meta", { name: "twitter:site", content: twitterSite }]);
}
if (twitterCreator) {
  siteHead.push(["meta", { name: "twitter:creator", content: twitterCreator }]);
}

function stripInlineMarkdown(text) {
  return text
    .replace(/\s*\{#.+?\}\s*$/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function toSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function linkToFilePath(link) {
  if (link === "/") {
    return resolve(docsRoot, "index.md");
  }

  if (link.endsWith("/")) {
    return resolve(docsRoot, `${link.slice(1)}index.md`);
  }

  return resolve(docsRoot, `${link.slice(1)}.md`);
}

function extractHeadingTree(link) {
  const filePath = linkToFilePath(link);
  let source = "";

  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const headingEntries = [];
  const slugCounters = new Map();
  let inFence = false;

  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const match = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const level = match[1].length;
    const text = stripInlineMarkdown(match[2]);
    if (!text) {
      continue;
    }

    const baseSlug = toSlug(text);
    if (!baseSlug) {
      continue;
    }

    const count = slugCounters.get(baseSlug) ?? 0;
    slugCounters.set(baseSlug, count + 1);
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;

    headingEntries.push({
      level,
      item: {
        text,
        link: `${link}#${slug}`,
        collapsed: true,
      },
    });
  }

  const tree = [];
  const stack = [];

  for (const entry of headingEntries) {
    while (stack.length > 0 && entry.level <= stack[stack.length - 1].level) {
      stack.pop();
    }

    if (stack.length === 0) {
      tree.push(entry.item);
    } else {
      const parent = stack[stack.length - 1].item;
      parent.items ||= [];
      parent.items.push(entry.item);
    }

    stack.push(entry);
  }

  return tree;
}

function withPageHeadings(items) {
  return items.map((item) => {
    if (item.items && !item.link) {
      return {
        ...item,
        collapsed: item.collapsed ?? true,
        items: withPageHeadings(item.items),
      };
    }

    if (!item.link || item.link.startsWith("http")) {
      return item;
    }

    const headingItems = extractHeadingTree(item.link);
    if (headingItems.length === 0) {
      return item;
    }

    return {
      ...item,
      collapsed: true,
      items: headingItems,
    };
  });
}

const baseSidebar = [
  {
    text: "Overview",
    items: [
      { text: "Home", link: "/" },
      { text: "Documentation Hubs", link: "/hubs" },
    ],
  },
  {
    text: "Get Started",
    collapsed: true,
    items: [
      { text: "Index", link: "/get-started/" },
      { text: "Quickstart", link: "/get-started/quickstart" },
      { text: "Device Targets", link: "/get-started/device-targets" },
      { text: "Configuration", link: "/get-started/configuration" },
      { text: "Deploy Documentation Site", link: "/get-started/deploy-docs" },
    ],
  },
  {
    text: "Concepts",
    collapsed: true,
    items: [
      { text: "Index", link: "/concepts/" },
      { text: "Project Blueprint", link: "/concepts/project-blueprint" },
      { text: "Architecture", link: "/concepts/architecture" },
      { text: "Remote Human Authorization", link: "/concepts/remote-human-authorization" },
      { text: "Prompting and Decision Model", link: "/concepts/prompting" },
      { text: "Sessions and Memory", link: "/concepts/sessions-memory" },
    ],
  },
  {
    text: "Tools",
    collapsed: true,
    items: [
      { text: "Index", link: "/tools/" },
      { text: "Skills", link: "/tools/skills" },
      { text: "Scripts", link: "/tools/scripts" },
    ],
  },
  {
    text: "Reference",
    collapsed: true,
    items: [
      { text: "Index", link: "/reference/" },
      { text: "Config Defaults", link: "/reference/config-defaults" },
      { text: "Prompt Templates", link: "/reference/prompt-templates" },
      { text: "Action and Output Schema", link: "/reference/action-schema" },
      { text: "Session and Memory Formats", link: "/reference/session-memory-formats" },
      { text: "CLI and Gateway", link: "/reference/cli-and-gateway" },
      { text: "Filesystem Layout", link: "/reference/filesystem-layout" },
    ],
  },
  {
    text: "Ops",
    collapsed: true,
    items: [
      { text: "Index", link: "/ops/" },
      { text: "Runbook", link: "/ops/runbook" },
      { text: "Troubleshooting", link: "/ops/troubleshooting" },
      { text: "Screen Awake Heartbeat", link: "/ops/screen-awake-heartbeat" },
    ],
  },
];

export default withMermaid(defineConfig({
  base: normalizedBase,
  lang: "en-US",
  title: siteTitle,
  description: siteDescription,
  head: siteHead,
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: [
    // Native app docs may not exist in all checkouts.
    /openpocket-menubar/,
  ],
  themeConfig: {
    siteTitle: "OpenPocket",
    logo: "/openpocket-logo.png",
    nav: [
      { text: "Setup", link: "/get-started/" },
      { text: "Docs", link: "/hubs" },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/SergioChan/openpocket" },
    ],
    sidebar: withPageHeadings(baseSidebar),
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
    },
    footer: {
      message: "<a href=\"https://github.com/SergioChan/openpocket\" target=\"_blank\" rel=\"noreferrer\">GitHub Repository</a>",
      copyright: "MIT License · OpenPocket Contributors",
    },
  },
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
  },
  mermaid: {},
}));
