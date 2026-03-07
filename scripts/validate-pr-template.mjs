import fs from "node:fs";
import path from "node:path";

const REQUIRED_SECTIONS = ["Summary", "Why", "Changes", "Testing", "Checklist"];
const REQUIRED_CHECKLIST_LINES = [
  "I ran relevant tests, or the Testing section explains why I did not.",
  "I updated docs, or confirmed no doc changes were needed.",
  "I confirmed the PR does not include secrets, credentials, or private data.",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripComments(text) {
  return text.replace(/<!--([\s\S]*?)-->/g, "").trim();
}

function extractSection(body, heading) {
  const pattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$\\n?([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "m");
  const match = body.match(pattern);
  return match ? match[1] : null;
}

function validateBody(body) {
  const errors = [];
  const normalizedBody = body.replace(/\r\n/g, "\n");

  for (const heading of REQUIRED_SECTIONS) {
    const section = extractSection(normalizedBody, heading);
    if (section === null) {
      errors.push(`Missing required section: ## ${heading}`);
      continue;
    }
    const cleaned = stripComments(section);
    if (!cleaned) {
      errors.push(`Section ## ${heading} must not be empty.`);
    }
  }

  const checklist = extractSection(normalizedBody, "Checklist");
  if (checklist !== null) {
    const cleanedChecklist = stripComments(checklist);
    const unchecked = cleanedChecklist.match(/^- \[ \]/gm) ?? [];
    if (unchecked.length > 0) {
      errors.push("All checklist items must be checked before merging.");
    }
    for (const line of REQUIRED_CHECKLIST_LINES) {
      const checkedPattern = new RegExp(`^- \\[x\\] ${escapeRegExp(line)}$`, "im");
      if (!checkedPattern.test(cleanedChecklist)) {
        errors.push(`Missing completed checklist item: ${line}`);
      }
    }
  }

  return errors;
}

function loadEventPayload(eventPath) {
  if (!eventPath) {
    throw new Error("Missing event payload. Set GITHUB_EVENT_PATH or pass --event-path <file>.");
  }
  const raw = fs.readFileSync(eventPath, "utf8");
  return JSON.parse(raw);
}

function resolveEventPath(argv) {
  const index = argv.indexOf("--event-path");
  if (index >= 0) {
    return argv[index + 1] ? path.resolve(argv[index + 1]) : null;
  }
  return process.env.GITHUB_EVENT_PATH || null;
}

function main() {
  const eventPath = resolveEventPath(process.argv.slice(2));
  const payload = loadEventPayload(eventPath);
  const body = payload?.pull_request?.body ?? "";
  const title = payload?.pull_request?.title ?? "(unknown title)";
  const errors = validateBody(body);

  if (errors.length > 0) {
    console.error(`PR template validation failed for: ${title}`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`PR template validation passed for: ${title}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { extractSection, stripComments, validateBody };
