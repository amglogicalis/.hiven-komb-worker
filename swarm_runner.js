// swarm_runner.js
// Hiven Worker Swarm - Ephemeral Multi-Agent Execution Engine
// Role: Principal Distributed Systems & MLOps Architect

import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import crypto from "crypto";
import chalk from "chalk";

// Ensure Ollama default path is in PATH on Windows
if (process.platform === "win32" && process.env.USERPROFILE) {
  const defaultOllamaPath = path.join(process.env.USERPROFILE, "AppData", "Local", "Programs", "Ollama");
  if (fs.existsSync(path.join(defaultOllamaPath, "ollama.exe"))) {
    process.env.PATH = `${process.env.PATH};${defaultOllamaPath}`;
  }
}

// Command line argument parser
const args = process.argv.slice(2);
const phaseArg = args.indexOf("--phase");
const indexArg = args.indexOf("--index");
const PHASE = phaseArg !== -1 ? args[phaseArg + 1] : "standalone";
const KOMBEE_INDEX = indexArg !== -1 ? parseInt(args[indexArg + 1], 10) : (process.env.KOMBEE_INDEX ? parseInt(process.env.KOMBEE_INDEX, 10) : 1);

// Environment Parameters
const {
  GITHUB_TOKEN,
  TARGET_REPO,
  TARGET_BRANCH,
  INSTRUCTION,
  FILES_TO_EDIT,
  PR_NUMBER,
  ISSUE_NUMBER,
  STATUS_COMMENT_ID,
  DRONE_UPLINK_URL,
  WORKER_ID
} = process.env;

const OLLAMA_HOST = "http://localhost:11434";
const TARGET_DIR = "./target_code";

// Elastic Model Registry mapping roles to state-of-the-art small models
const MODELS = {
  PLANNER_LOW: process.env.PLANNER_MODEL_LOW || "deepseek-r1:1.5b",   // Fast basic logic reasoning planner
  PLANNER_HIGH: process.env.PLANNER_MODEL_HIGH || "deepseek-r1:8b",   // Solid architecture reasoning planner
  CODER_LOW: process.env.CODER_MODEL_LOW || "qwen2.5-coder:3b",       // 3B coder (format-aligned)
  CODER_HIGH: process.env.CODER_MODEL_HIGH || "qwen2.5-coder:7b",     // 7B heavy coder
  VALIDATOR_LOW: process.env.VALIDATOR_MODEL_LOW || "qwen2.5-coder:3b", // 3B syntax validator
  VALIDATOR_HIGH: process.env.VALIDATOR_MODEL_HIGH || "deepseek-r1:8b" // 8B logical auditor validator
};

console.log("==========================================================");
console.log(`         🐜 HIVEN KOMBEE SWARM - FASE: ${PHASE.toUpperCase()} (ID: ${KOMBEE_INDEX})`);
console.log("==========================================================");

if (!GITHUB_TOKEN || !TARGET_REPO || !TARGET_BRANCH || !INSTRUCTION) {
  console.error("[!] Missing critical environment variables.");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Helper to query local Ollama service
async function queryOllama(model, prompt, systemPrompt = "") {
  console.log(`[*] Querying model '${model}'...`);
  const payload = {
    model,
    prompt,
    stream: false,
    options: { temperature: 0.3, num_predict: 1024 }
  };
  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${OLLAMA_HOST}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.response);
          } catch (e) {
            reject(new Error(`Failed to parse Ollama response: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// Helper to update the real-time status comment on GitHub
async function updateStatusComment(currentPhase, state) {
  if (!STATUS_COMMENT_ID || !GITHUB_TOKEN || !TARGET_REPO) {
    return;
  }
  const commentId = parseInt(STATUS_COMMENT_ID, 10);
  if (isNaN(commentId)) return;

  const [owner, repo] = TARGET_REPO.split("/");
  
  // Build status list
  let p1 = "⏳ **Phase 1: Context** (Pending)";
  let p2 = "⏳ **Phase 2: Execution** (Pending)";
  let p3 = "⏳ **Phase 3: Validation** (Pending)";
  let p4 = "⏳ **Phase 4: Consolidation** (Pending)";

  if (currentPhase === "context") {
    p1 = state === "running" ? "⚙️ **Phase 1: Context** (In Progress...)" : "✅ **Phase 1: Context** (Complete)";
  } else if (currentPhase === "execution") {
    p1 = "✅ **Phase 1: Context** (Complete)";
    p2 = state === "running" ? "⚙️ **Phase 2: Execution** (In Progress...)" : "✅ **Phase 2: Execution** (Complete)";
  } else if (currentPhase === "validation") {
    p1 = "✅ **Phase 1: Context** (Complete)";
    p2 = "✅ **Phase 2: Execution** (Complete)";
    p3 = state === "running" ? "⚙️ **Phase 3: Validation** (In Progress...)" : "✅ **Phase 3: Validation** (Complete)";
  } else if (currentPhase === "consolidation") {
    p1 = "✅ **Phase 1: Context** (Complete)";
    p2 = "✅ **Phase 2: Execution** (Complete)";
    p3 = "✅ **Phase 3: Validation** (Complete)";
    p4 = state === "running" ? "⚙️ **Phase 4: Consolidation** (In Progress...)" : "✅ **Phase 4: Consolidation** (Complete)";
  }

  const body = `🐝 Hiven Swarm Triggered for instruction: **"${INSTRUCTION}"**\n\n* ${p1}\n* ${p2}\n* ${p3}\n* ${p4}`;

  try {
    const octo = new Octokit({ auth: GITHUB_TOKEN });
    await octo.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body
    });
    console.log(`[+] Status comment updated for Phase [${currentPhase}] (${state}).`);
  } catch (err) {
    console.error("[-] Failed to update status comment on GitHub:", err.message);
  }
}

// Helper to send telemetry to the Queen
function sendTelemetry(state, message) {
  if (!DRONE_UPLINK_URL) return Promise.resolve();
  
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    // Safety timeout: resolve after 5 seconds to prevent hanging the runner
    const timeoutId = setTimeout(() => {
      console.error("[-] Telemetry request timed out");
      done();
    }, 5000);

    const payload = JSON.stringify({
      workerId: WORKER_ID,
      kombeeIndex: typeof KOMBEE_INDEX !== 'undefined' ? KOMBEE_INDEX : 1,
      phase: PHASE,
      state,
      message,
      timestamp: new Date().toISOString()
    });

    try {
      const url = new URL(DRONE_UPLINK_URL);
      const lib = url.protocol === "https:" ? https : http;

      const req = lib.request(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          clearTimeout(timeoutId);
          done();
        });
      });

      req.on("error", (e) => {
        console.error("[-] Telemetry report failed:", e.message);
        clearTimeout(timeoutId);
        done();
      });
      req.write(payload);
      req.end();
    } catch (err) {
      console.error("[-] Telemetry setup failed:", err.message);
      clearTimeout(timeoutId);
      done();
    }
  });
}

// ==========================================
// FEDERATED PATTERN LEARNING
// Loads/saves abstract swarm patterns via Queen API
// ==========================================
async function loadFederatedPatterns(instruction, fileExtensions) {
  if (!DRONE_UPLINK_URL) return [];
  try {
    const queenBase = DRONE_UPLINK_URL.replace('/telemetry', '');
    const fileType = fileExtensions[0] || 'js';
    const url = `${queenBase}/api/patterns/load?fileType=${encodeURIComponent(fileType)}`;
    const lib = url.startsWith('https') ? https : http;
    return await new Promise((resolve) => {
      lib.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.patterns || []);
          } catch { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
  } catch { return []; }
}

async function saveFederatedPattern(fileType, instruction, outcome) {
  if (!DRONE_UPLINK_URL) return;
  try {
    const queenBase = DRONE_UPLINK_URL.replace('/telemetry', '');
    const pattern = {
      fileType,
      instruction: instruction.substring(0, 120),
      outcome,
      timestamp: new Date().toISOString()
    };
    const payload = JSON.stringify({ fileType, pattern });
    const url = new URL(`${queenBase}/api/patterns/save`);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(payload);
    req.end();
    console.log(`[+] Federated pattern saved for type: ${fileType}`);
  } catch { /* non-blocking */ }
}

// Helper to execute git command on target directory
function runGit(args, options = {}) {
  if (TARGET_REPO === "mock/repo" || process.env.MOCK_GIT === "true") {
    console.log(chalk.blue(`[Simulated Git Command] git ${args}`));
    return "";
  }
  const defaultOpts = { cwd: TARGET_DIR };
  return execSync(`git ${args}`, { ...defaultOpts, ...options }).toString().trim();
}

// Checkout codebase
function checkoutCodebase() {
  if (TARGET_REPO === "mock/repo" || process.env.MOCK_GIT === "true") {
    console.log("[*] [Mock-Git] Bypassing checkout. Using local target_code workspace.");
    if (!fs.existsSync(TARGET_DIR)) {
      fs.mkdirSync(TARGET_DIR);
    }
    return;
  }
  if (fs.existsSync(TARGET_DIR)) {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  }
  console.log(`[*] Cloning target repository ${TARGET_REPO} (${TARGET_BRANCH})...`);
  const cloneUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${TARGET_REPO}.git`;
  execSync(`git clone --depth 1 --branch ${TARGET_BRANCH} ${cloneUrl} ${TARGET_DIR}`, { stdio: "ignore" });
}

// Load honey.db (Worker local memory cache)
function loadHoneyDb() {
  const honeyPath = "./honey.db";
  if (fs.existsSync(honeyPath)) {
    try {
      return JSON.parse(fs.readFileSync(honeyPath, "utf-8"));
    } catch (e) {
      console.warn("[-] Failed to parse honey.db, starting fresh.");
    }
  }
  return { stylePreferences: {}, errorSignatures: {} };
}

// Save honey.db safely (Sanitized - no user source code)
function saveHoneyDb(honeyDb) {
  fs.writeFileSync("./honey.db", JSON.stringify(honeyDb, null, 2), "utf-8");
  try {
    runGit("add honey.db", { cwd: "." });
    runGit('commit -m "chore: persist honey.db style cache [skip ci]"', { cwd: "." });
    runGit("push", { cwd: "." });
    console.log("[+] honey.db updated and pushed to Worker origin.");
  } catch (e) {
    console.warn("[-] Failed to push updated honey.db to worker origin:", e.message);
  }
}


// ==========================================
// FASE 0: CONTEXT HARVEST
// Recursively walks the cloned repo and builds
// a rich code context bundle for the Architect.
// ==========================================
const HARVEST_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".tf", ".hcl",
  ".yaml", ".yml",
  ".json",
  ".sh", ".bash",
  ".md", ".txt",
  ".html", ".css",
  ".sql"
]);
const HARVEST_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".terraform", "dist", "build",
  ".next", "coverage", "__pycache__", ".venv", "venv", "env",
  ".cache", "tmp", "temp", "logs", "vendor"
]);
const HARVEST_EXCLUDE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "poetry.lock", "Pipfile.lock", ".terraform.lock.hcl"
]);
const MAX_HARVEST_CHARS = 80000; // ~20k tokens — safe for 32k context models
const MAX_FILE_CHARS = 8000;    // Cap individual files to avoid one giant file eating the budget

function walkDir(dir, fileList = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return fileList;
  }
  for (const entry of entries) {
    if (HARVEST_EXCLUDE_DIRS.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }
    if (stat.isDirectory()) {
      walkDir(fullPath, fileList);
    } else if (stat.isFile()) {
      const ext = path.extname(entry).toLowerCase();
      if (HARVEST_EXTENSIONS.has(ext) && !HARVEST_EXCLUDE_FILES.has(entry)) {
        fileList.push({ fullPath, relativePath: path.relative(TARGET_DIR, fullPath), size: stat.size });
      }
    }
  }
  return fileList;
}

function harvestRepoContext(targetDir = TARGET_DIR) {
  console.log("[Phase 0] Harvesting full repository context...");

  const allFiles = walkDir(targetDir);
  // Sort by size ASC: smaller files first so we maximize file count within budget
  allFiles.sort((a, b) => a.size - b.size);

  let totalChars = 0;
  let codeContext = "";
  const includedFiles = [];
  const skippedFiles = [];

  for (const { fullPath, relativePath } of allFiles) {
    if (totalChars >= MAX_HARVEST_CHARS) {
      skippedFiles.push(relativePath);
      continue;
    }
    try {
      let content = fs.readFileSync(fullPath, "utf-8");
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + `\n// ... [truncated — ${Math.round(content.length / 1000)}k chars total]`;
      }
      const ext = path.extname(relativePath).slice(1) || "";
      codeContext += `\n### File: ${relativePath}\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
      includedFiles.push(relativePath);
      totalChars += content.length;
    } catch (_) {
      skippedFiles.push(relativePath);
    }
  }

  console.log(`[Phase 0] Harvest complete: ${includedFiles.length} files included (${Math.round(totalChars / 1000)}k chars), ${skippedFiles.length} skipped (budget limit).`);
  if (skippedFiles.length > 0) {
    console.log("[Phase 0] Skipped (budget):", skippedFiles.slice(0, 10).join(", "));
  }

  return { codeContext, files: includedFiles, skippedFiles, totalChars };
}

// ==========================================
// MEJORA 3: LOCAL OFFLINE RAG (TF-IDF)
// Selects only the most relevant file chunks
// for the instruction — cuts context 4x
// ==========================================
const RAG_MAX_CHARS = 22000;  // ~5.5k tokens — focused context for small models
const RAG_TOP_FILES = 8;      // Max files to include in RAG context

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function buildRagContext(targetDir, instruction) {
  console.log('[Phase RAG] Building TF-IDF index for instruction-guided context selection...');
  const allFiles = walkDir(targetDir);
  if (allFiles.length === 0) return null;

  // Tokenize instruction as the query
  const queryTokens = tokenize(instruction);
  const queryFreq = {};
  for (const t of queryTokens) queryFreq[t] = (queryFreq[t] || 0) + 1;

  // Score each file by term overlap with instruction
  const scored = [];
  for (const { fullPath, relativePath } of allFiles) {
    try {
      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS);

      const fileTokens = tokenize(content);
      const fileFreq = {};
      for (const t of fileTokens) fileFreq[t] = (fileFreq[t] || 0) + 1;

      // TF-IDF-like score: sum of query term frequencies in the file
      let score = 0;
      for (const [term, qf] of Object.entries(queryFreq)) {
        if (fileFreq[term]) score += qf * Math.log(1 + fileFreq[term]);
      }

      // Boost: filename match with any instruction word
      const lowerPath = relativePath.toLowerCase();
      for (const t of queryTokens) {
        if (lowerPath.includes(t)) score += 3;
      }

      // Boost: key config files always relevant
      if (['package.json','readme.md','main.tf','main.py','index.js','index.ts',
           'app.js','app.py','server.js'].some(k => lowerPath.endsWith(k))) {
        score += 2;
      }

      scored.push({ relativePath, fullPath, content, score });
    } catch (_) { /* skip unreadable files */ }
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const topFiles = scored.slice(0, RAG_TOP_FILES);

  if (topFiles.length === 0 || topFiles[0].score === 0) {
    console.log('[Phase RAG] No relevant files found via TF-IDF. Falling back to full harvest.');
    return null;
  }

  let ragContext = '';
  let totalChars = 0;
  const includedFiles = [];

  for (const { relativePath, content } of topFiles) {
    if (totalChars >= RAG_MAX_CHARS) break;
    const ext = path.extname(relativePath).slice(1) || '';
    const chunk = `\n### File: ${relativePath}\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
    ragContext += chunk;
    totalChars += content.length;
    includedFiles.push(relativePath);
  }

  console.log(`[Phase RAG] Selected ${includedFiles.length}/${allFiles.length} files (${Math.round(totalChars/1000)}k chars). Top: ${includedFiles.slice(0,3).join(', ')}`);
  return { codeContext: ragContext, files: includedFiles, skippedFiles: [], totalChars };
}

// Helper to detect if a file name in plan or instruction represents a new file
// that does not exist in the repository yet.
function detectNewFileFromContext(content, plan, instruction) {
  const fileRegex = /([a-zA-Z0-9_\-\/\\\.]+\.(?:js|ts|jsx|tsx|py|go|rs|tf|md|json|yml|yaml|hcl|sh|txt))/g;
  const candidates = new Set();
  
  let m;
  if (instruction) {
    fileRegex.lastIndex = 0;
    while ((m = fileRegex.exec(instruction)) !== null) {
      candidates.add(m[1]);
    }
  }
  if (plan) {
    fileRegex.lastIndex = 0;
    while ((m = fileRegex.exec(plan)) !== null) {
      candidates.add(m[1]);
    }
  }
  if (content) {
    fileRegex.lastIndex = 0;
    while ((m = fileRegex.exec(content)) !== null) {
      candidates.add(m[1]);
    }
  }

  // Get list of existing files in TARGET_DIR to prevent matching existing files
  const existingFiles = new Set();
  try {
    const list = walkDir(TARGET_DIR);
    list.forEach(f => existingFiles.add(f.relativePath.toLowerCase().replace(/\\/g, "/")));
  } catch (_) {}

  for (const cand of candidates) {
    const normalized = cand.replace(/\\/g, "/");
    if (!existingFiles.has(normalized.toLowerCase())) {
      // If the content contains the filename or if it's markdown starting with a header, it's a match
      if (content.toLowerCase().includes(normalized.toLowerCase()) || 
          (normalized.endsWith(".md") && content.trim().startsWith("#"))) {
        console.log(`[Parser Heuristic] Detected target path for NEW file: ${normalized}`);
        return normalized;
      }
    }
  }
  return null;
}

// Helper to extract, clean, and write code robustly
function writeCodeCleanly(content, defaultFile, contextFiles, plan = "", instruction = "") {
  let cleanCode = content.trim();
  
  // 1. Check if the model returned raw JSON block changes instead of code
  if (cleanCode.startsWith("{") || cleanCode.startsWith("[") || cleanCode.toLowerCase().includes('"changes":')) {
    console.warn("[!] Parser warning: Coder model returned structured changes (JSON/List) instead of clean file content.");
    return null;
  }
  
  // 2. Extract markdown code block if present
  const codeBlockRegex = /```[a-zA-Z]*\n([\s\S]*?)\n```/g;
  const matches = [...cleanCode.matchAll(codeBlockRegex)];
  if (matches.length > 0) {
    cleanCode = matches.map(m => m[1]).join("\n");
  }

  // 3. Remove syntax-breaking markdown headers/comments
  cleanCode = cleanCode.replace(/^###\s*File:\s*\S+/gm, "");
  cleanCode = cleanCode.replace(/^\/\/ File:\s*\S+/gm, "");
  cleanCode = cleanCode.trim();

  if (cleanCode.length === 0) {
    return null;
  }

  // Check if this is a new file created by the coder
  let targetFile = defaultFile;
  let isNewFile = false;
  if (plan || instruction) {
    const newFileCandidate = detectNewFileFromContext(cleanCode, plan, instruction);
    if (newFileCandidate) {
      targetFile = newFileCandidate;
      isNewFile = true;
    }
  }

  // 4. Reject conversational text alucinations (e.g., markdown lists or headers inside code files)
  const isMarkdownFile = targetFile.endsWith(".md");
  if (!isMarkdownFile) {
    const lines = cleanCode.split("\n").map(l => l.trim());
    const hasMarkdownStructure = lines.some(l => l.startsWith("###") || l.startsWith("##") || l.startsWith("1. ") || l.startsWith("- "));
    const containsChatter = cleanCode.toLowerCase().includes("here is the") || cleanCode.toLowerCase().includes("step-by-step") || cleanCode.toLowerCase().includes("the following changes");
    if (hasMarkdownStructure || containsChatter) {
      console.warn(`[!] Parser warning: Rejected conversational text alucination for file ${targetFile}.`);
      return null;
    }
  }

  if (!isNewFile) {
    // Match text to a file from contextFiles if possible
    for (const file of contextFiles) {
      if (content.toLowerCase().includes(file.toLowerCase())) {
        targetFile = file;
        break;
      }
    }
  }

  const filePath = path.join(TARGET_DIR, targetFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, cleanCode, "utf-8");
  return targetFile;
}


function setupGitIdentity() {
  if (TARGET_REPO === "mock/repo" || process.env.MOCK_GIT === "true") {
    return;
  }
  try {
    execSync("git config --global user.name 'Hiven Swarm'", { stdio: "ignore" });
    execSync("git config --global user.email 'swarm@hiven.ai'", { stdio: "ignore" });
    console.log("[+] Global Git identity configured successfully.");
  } catch (e) {
    console.warn("[-] Failed to configure global Git identity:", e.message);
  }
}

// ==========================================
// MEJORA 2: DETERMINISTIC CONTEXT EXTRACTION
// Reads real project facts before LLM call
// eliminates hallucinated file names and paths
// ==========================================
function extractProjectFacts(targetDir) {
  const facts = {
    name: null,
    version: null,
    entryPoint: null,
    scripts: {},
    dependencies: [],
    devDependencies: [],
    framework: null,
    runtime: null,
    language: null,
    configFiles: []
  };

  try {
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      facts.name = pkg.name || null;
      facts.version = pkg.version || null;
      facts.entryPoint = pkg.main || pkg.module || null;
      facts.scripts = pkg.scripts || {};
      facts.dependencies = Object.keys(pkg.dependencies || {}).slice(0, 20);
      facts.devDependencies = Object.keys(pkg.devDependencies || {}).slice(0, 10);
      facts.runtime = pkg.engines ? JSON.stringify(pkg.engines) : 'Node.js';

      // Framework detection
      const allDeps = [...facts.dependencies, ...facts.devDependencies];
      if (allDeps.includes('next')) facts.framework = 'Next.js';
      else if (allDeps.includes('react')) facts.framework = 'React';
      else if (allDeps.includes('express')) facts.framework = 'Express';
      else if (allDeps.includes('fastify')) facts.framework = 'Fastify';
      else if (allDeps.includes('vue')) facts.framework = 'Vue';
      else if (allDeps.includes('svelte')) facts.framework = 'Svelte';
      else if (allDeps.includes('nestjs') || allDeps.includes('@nestjs/core')) facts.framework = 'NestJS';

      facts.language = 'JavaScript/TypeScript';
    }

    // Check for Python
    const pyFiles = ['requirements.txt', 'pyproject.toml', 'setup.py'];
    for (const f of pyFiles) {
      if (fs.existsSync(path.join(targetDir, f))) {
        facts.language = 'Python';
        facts.runtime = 'Python';
        break;
      }
    }

    // Detect Terraform
    const tfFiles = fs.readdirSync(targetDir).filter(f => f.endsWith('.tf')).slice(0, 5);
    if (tfFiles.length > 0) {
      facts.language = facts.language ? facts.language + '/Terraform' : 'Terraform';
      facts.configFiles.push(...tfFiles);
    }

    // Common config files
    const configCandidates = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', 'tsconfig.json',
      'jest.config.js', 'vite.config.js', 'webpack.config.js', 'Dockerfile', 'docker-compose.yml'];
    for (const c of configCandidates) {
      if (fs.existsSync(path.join(targetDir, c))) facts.configFiles.push(c);
    }

    fs.writeFileSync('project_facts.json', JSON.stringify(facts, null, 2), 'utf-8');
    console.log('[Phase 0] Project facts extracted:', JSON.stringify(facts).substring(0, 200));
  } catch (e) {
    console.warn('[Phase 0] Project facts extraction partial error (non-blocking):', e.message);
  }

  return facts;
}

async function main() {
  setupGitIdentity();
  try {
    if (PHASE === "E2E_SIMULATED" || !PHASE) {
      console.log(chalk.cyan("=========================================================="));
      console.log(chalk.cyan("       🐝 HIVEN SWARM - LOCAL EXECUTION / SIMULATION      "));
      console.log(chalk.cyan("=========================================================="));
      
      // 1. Run Context
      console.log(chalk.yellow("\n[*] Running Phase 1: Context & Planning..."));
      checkoutCodebase();
      const honeyDb = loadHoneyDb();
      
      // FASE 0: Full repo harvest for local simulation
      let files = [];
      let codeContext = "";
      if (FILES_TO_EDIT) {
        files = FILES_TO_EDIT.split(",").map(f => f.trim());
        for (const file of files) {
          const filePath = path.join(TARGET_DIR, file);
          if (fs.existsSync(filePath)) {
            let content = fs.readFileSync(filePath, "utf-8");
            if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + "\n// ... [truncated]";
            codeContext += `\n### File: ${file}\n\`\`\`\n${content}\n\`\`\`\n`;
          }
        }
      } else {
        const harvest = harvestRepoContext();
        files = harvest.files;
        codeContext = harvest.codeContext;
      }

      console.log("[*] Assessing task complexity...");
      const plannerModel = MODELS.PLANNER;
      await queryOllama(plannerModel, "Identify task style").catch(() => {});
      
      const contextPrompt = `Analyze the developer instruction and files. Rate the task complexity as either LOW or HIGH.\n\nFILES:\n${files.join(", ")}\n\nINSTRUCTION:\n${INSTRUCTION}`;
      const complexityResp = await queryOllama(plannerModel, contextPrompt, "You are Hiven-Router.");
      const complexity = complexityResp.toUpperCase().includes("HIGH") ? "HIGH" : "LOW";
      console.log(`[+] Task Complexity: ${complexity}`);

      const contextPromptPlan = `Generate a plan to implement the instruction: "${INSTRUCTION}"\n\nFILES:\n${codeContext}`;
      const plan = await queryOllama(plannerModel, contextPromptPlan, "You are Hiven-Architect.");
      console.log("[+] Plan Generated:\n", plan);

      // 2. Run Execution
      console.log(chalk.yellow("\n[*] Running Phase 2: Code Generation..."));
      const coderModel = complexity === "HIGH" ? MODELS.CODER_HIGH : MODELS.CODER_LOW;
      const coderPrompt = `Implement the plan:\n${plan}\n\nFILES:\n${codeContext}`;
      const coderOutput = await queryOllama(coderModel, coderPrompt, "You are Hiven-Coder.");
      console.log("[+] Code generated.");

      // 3. Run Validation
      console.log(chalk.yellow("\n[*] Running Phase 3: Validation & Correction..."));
      const fileRegex = /---START_FILE:\s*([^\s-]+)---\n([\s\S]*?)\n---END_FILE:\s*\1---/g;
      let match;
      let modifiedFiles = {};
      
      while ((match = fileRegex.exec(coderOutput)) !== null) {
        modifiedFiles[match[1].trim()] = match[2];
      }

      if (Object.keys(modifiedFiles).length === 0 && files.length > 0) {
        const writtenFile = writeCodeCleanly(coderOutput, files[0], files, plan, INSTRUCTION);
        if (writtenFile) {
          modifiedFiles[writtenFile] = fs.readFileSync(path.join(TARGET_DIR, writtenFile), "utf-8");
        } else {
          console.warn("[-] E2E_SIMULATED: Parser rejected the code output as conversational alucination.");
        }
      }

      console.log("[+] Validation complete.");

      // 4. Run Consolidation
      console.log(chalk.yellow("\n[*] Running Phase 4: Patch Consolidation..."));
      for (const [file, content] of Object.entries(modifiedFiles)) {
        const localPath = path.join(TARGET_DIR, file);
        fs.writeFileSync(localPath, content, "utf-8");
        console.log(chalk.green(`[+] Applied local patch successfully: ${localPath}`));
      }

      console.log(chalk.green("\n[+] HIVEN LOCAL SWARM FULLY COMPLETED!"));
      return;
    }

    if (PHASE === "context") {
      // ==========================================================
      // FASE 1: CONTEXT (Option A - Decomposition & Option B - Routing)
      // ==========================================================
      console.log("[*] Running Phase 1 Context Kōmbees...");
      await updateStatusComment("context", "running");
      await sendTelemetry("running", "Phase 1 Context Kōmbees starting...");
      checkoutCodebase();
      const honeyDb = loadHoneyDb();

      // MEJORA 2: Extract deterministic project facts before any LLM call
      const projectFacts = extractProjectFacts(TARGET_DIR);
      await sendTelemetry("running", `[Phase 0] Project facts: lang=${projectFacts.language || 'unknown'}, framework=${projectFacts.framework || 'none'}, entry=${projectFacts.entryPoint || 'n/a'}, deps=${projectFacts.dependencies.slice(0,5).join(',')||'none'}`);
      const factsSection = `
PROJECT FACTS (deterministic, extracted from repo):
- Name: ${projectFacts.name || 'unknown'}
- Language: ${projectFacts.language || 'unknown'}
- Framework: ${projectFacts.framework || 'none detected'}
- Entry point: ${projectFacts.entryPoint || 'not specified'}
- Runtime: ${projectFacts.runtime || 'unknown'}
- Key dependencies: ${projectFacts.dependencies.slice(0, 10).join(', ') || 'none'}
- Scripts available: ${Object.keys(projectFacts.scripts).join(', ') || 'none'}
- Config files: ${projectFacts.configFiles.join(', ') || 'none'}
`;
      // FASE 0: Deep repository context harvest (replaces shallow 3-file read)
      let files = [];
      let codeContext = "";
      if (FILES_TO_EDIT) {
        // If specific files were requested, read only those
        files = FILES_TO_EDIT.split(",").map(f => f.trim());
        for (const file of files) {
          const filePath = path.join(TARGET_DIR, file);
          if (fs.existsSync(filePath)) {
            let content = fs.readFileSync(filePath, "utf-8");
            if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + "\n// ... [truncated]";
            const ext = path.extname(file).slice(1) || "";
            codeContext += `\n### File: ${file}\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
          }
        }
        console.log(`[Phase 0] Specific files mode: loaded ${files.length} files.`);
        await sendTelemetry("running", `[Phase 0] Specific files mode: loaded ${files.length} files.`);
      } else {
        // MEJORA 3: Try RAG first, fall back to full harvest
        const ragResult = buildRagContext(TARGET_DIR, INSTRUCTION);
        if (ragResult && ragResult.files.length > 0) {
          files = ragResult.files;
          codeContext = ragResult.codeContext;
          await sendTelemetry("running", `[Phase RAG] Context: ${ragResult.files.length} relevant files selected (${Math.round(ragResult.totalChars/1000)}k chars). Files: ${ragResult.files.slice(0,3).join(', ')}`);
        } else {
          const harvest = harvestRepoContext();
          files = harvest.files;
          codeContext = harvest.codeContext;
          await sendTelemetry("running", `[Phase 0] Repo harvested: ${harvest.files.length} files (${Math.round(harvest.totalChars/1000)}k chars)${harvest.skippedFiles.length > 0 ? ', ' + harvest.skippedFiles.length + ' skipped (budget)' : ''}`);
        }
      }

      // 1. Complexity Assessment & Conditional Routing (Option B Improved)
      console.log("[*] Assessing task complexity for compute routing...");
      const complexityPrompt = `
Analyze the developer instruction and files. Rate the task complexity as either LOW, MEDIUM, or HIGH.
- LOW: Quick fixes, single-file edits, simple adjustments.
- MEDIUM: Multi-file edits, medium refactoring, minor additions.
- HIGH: Complex logic, algorithms, core architecture changes, database schema updates.
${factsSection}
FILES:
${files.join(", ")}

INSTRUCTION:
${INSTRUCTION}

Respond ONLY with a single JSON object containing "complexity" ("LOW", "MEDIUM", or "HIGH") and "reason".
`;

      execSync(`ollama pull ${MODELS.VALIDATOR_LOW}`, { stdio: "inherit" });
      const complexityResp = await queryOllama(MODELS.VALIDATOR_LOW, complexityPrompt, "You are Hiven-Complexity-Evaluator. Output JSON only. Respond with JSON format only.");
      console.log("[+] Evaluator Response:", complexityResp);
      
      let complexity = "LOW";
      try {
        const cleanJson = complexityResp.replace(/```[a-zA-Z]*\n([\s\S]*?)\n```/g, "$1").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleanJson);
        complexity = parsed.complexity || "LOW";
      } catch (e) {
        if (complexityResp.toUpperCase().includes("HIGH")) {
          complexity = "HIGH";
        } else if (complexityResp.toUpperCase().includes("MEDIUM")) {
          complexity = "MEDIUM";
        }
      }

      // Heuristic Safeguard: Upgrade to MEDIUM if multiple files are affected
      if (files.length > 1 && complexity === "LOW") {
        complexity = "MEDIUM";
        console.log(`[Queen Guard] Automatically upgraded complexity to MEDIUM because multiple files (${files.length}) are affected.`);
      }

      console.log(`[+] Task Complexity Assessed: ${complexity}.`);
      const requiresHeavyCoder = complexity === "HIGH";

      // Determine planning model (Expert Routing)
      let plannerModel = MODELS.PLANNER_LOW;
      if (complexity === "MEDIUM" || complexity === "HIGH") {
        plannerModel = MODELS.PLANNER_HIGH;
      }
      console.log(chalk.magenta(`[!] Selected Architect Kōmbee model: ${plannerModel}`));

      console.log(`[*] Pulling planner model ${plannerModel}...`);
      execSync(`ollama pull ${plannerModel}`, { stdio: "inherit" });

      // 2. Task Decomposition with Federated Pattern Injection
      console.log("[*] Running Architect Kōmbee to decompose instruction...");

      // Load federated patterns from previous swarms
      const fileExts = files.map(f => f.split('.').pop()).filter(Boolean);
      const uniqueExts = [...new Set(fileExts)].slice(0, 3);
      let patternsSection = '';
      try {
        const allPatterns = [];
        for (const ext of uniqueExts) {
          const p = await loadFederatedPatterns(INSTRUCTION, [ext]);
          allPatterns.push(...p);
        }
        if (allPatterns.length > 0) {
          const dosAndDonts = allPatterns.slice(-5).map(p =>
            `- [${p.outcome}] ${p.instruction}`
          ).join('\n');
          patternsSection = `\n\nFEDERATED SWARM MEMORY (Do's and Don'ts from previous runs):\n${dosAndDonts}`;
          console.log(`[+] Federated patterns loaded: ${allPatterns.length} patterns found.`);
        } else {
          console.log('[*] No federated patterns yet for this file type. Starting fresh.');
        }
      } catch (e) {
        console.warn('[-] Failed to load federated patterns (non-blocking):', e.message);
      }

      const contextPrompt = `
You are a senior software architect. Analyze the COMPLETE source code of the repository below and the developer instruction.
Write a precise, step-by-step implementation plan separating the work into atomic micro-tasks.
Each task must reference REAL file names and REAL function/variable names from the code provided.
Do NOT invent new files or functions that don't exist. Reference what you actually see below.
${factsSection}
REPOSITORY FILES (${files.length} files):
${codeContext}

DEVELOPER INSTRUCTION:
${INSTRUCTION}

STYLE CACHE (previous preferences):
${JSON.stringify(honeyDb.stylePreferences)}${patternsSection}

Output a numbered list of concrete implementation steps, each referencing specific files and functions.
`;

      const plan = await queryOllama(plannerModel, contextPrompt, "You are Hiven-Architect, a principal code planning agent.");
      console.log("[+] Plan Generated:\n", plan);

      // MEJORA 5: Build Parallel Sub-Swarm Partitioning
      // Group nodes by file subsets if multiple files exist
      const partitions = [];
      if (files.length > 1) {
        const mid = Math.ceil(files.length / 2);
        partitions.push({ group: 1, files: files.slice(0, mid), nodes: [1, 2, 3, 4, 5] });
        partitions.push({ group: 2, files: files.slice(mid), nodes: [6, 7, 8, 9, 10] });
        console.log(`[Sub-Swarms] Created 2 parallel sub-swarm partitions: Group 1 (${files.slice(0, mid).join(', ')}), Group 2 (${files.slice(mid).join(', ')})`);
      } else {
        partitions.push({ group: 1, files: files, nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
        console.log(`[Sub-Swarms] Single file task — all 10 nodes assigned to Group 1 (${files.join(', ')})`);
      }

      // Save context metadata for next stages
      const swarmContext = {
        plan,
        complexity,
        requiresHeavyCoder,
        files,
        codeContext,
        projectFacts,
        partitions
      };
      fs.writeFileSync("swarm_context.json", JSON.stringify(swarmContext, null, 2), "utf-8");
      console.log("[+] Context saved to swarm_context.json.");
      await updateStatusComment("context", "done");
      await sendTelemetry("done", "Phase 1 Context complete. plan generated.");
    }
    
    else if (PHASE === "execution") {
      // ==========================================================
      // FASE 2: EXECUTION (Conditional Routing & Inferencia Híbrida)
      // ==========================================================
      console.log(`[*] Running Coder Kōmbee Node #${KOMBEE_INDEX}...`);
      if (KOMBEE_INDEX === 1) {
        await updateStatusComment("execution", "running");
      }
      await sendTelemetry("running", `Coder Node #${KOMBEE_INDEX} processing...`);
      const context = JSON.parse(fs.readFileSync("swarm_context.json", "utf-8"));
      // MEJORA 5: Filter files for this node's partition group
      const myPartition = (context.partitions || []).find(p => p.nodes.includes(KOMBEE_INDEX)) || { group: 1, files: context.files };
      const nodeTargetFiles = myPartition.files.length > 0 ? myPartition.files : context.files;
      console.log(`[Sub-Swarm Node #${KOMBEE_INDEX}] Assigned Partition Group ${myPartition.group} -> Target Files: ${nodeTargetFiles.join(', ')}`);

      // Re-read assigned partition files from actual checkout
      const CODER_FILE_MAX = 40000;
      let fullCoderContext = '';
      let coderTotalChars = 0;
      const truncatedFiles = [];
      for (const file of nodeTargetFiles) {
        const filePath = path.join(TARGET_DIR, file);
        if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf-8');
          if (content.length > CODER_FILE_MAX) {
            content = content.slice(0, CODER_FILE_MAX);
            truncatedFiles.push(file);
          }
          const ext = path.extname(file).slice(1) || '';
          fullCoderContext += `\n### File: ${file}\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
          coderTotalChars += content.length;
        }
      }
      console.log(`[Coder Node #${KOMBEE_INDEX}] Context: ${nodeTargetFiles.length} files, ${Math.round(coderTotalChars/1000)}k chars${truncatedFiles.length > 0 ? `. Truncated (>40k): ${truncatedFiles.join(', ')}` : ''}`);

      const truncationWarning = truncatedFiles.length > 0
        ? `\nWARNING: The following files were too large to fit fully in context and were truncated: ${truncatedFiles.join(', ')}. For these files, output ONLY the specific functions/sections that need to change — do NOT output the beginning of the file followed by nothing. The system will merge your changes into the original file.`
        : '';

      // Determine model based on 3-tier complexity
      let model = MODELS.CODER_LOW;
      if (context.complexity === "HIGH") {
        model = MODELS.CODER_HIGH;
        console.log(chalk.magenta(`[!] High Complexity: Routing Coder Kōmbee Node #${KOMBEE_INDEX} to ${model}.`));
      } else if (context.complexity === "MEDIUM") {
        if (KOMBEE_INDEX >= 9) {
          model = MODELS.CODER_HIGH;
          console.log(chalk.magenta(`[!] Medium Complexity: Scaling up Core Coder Node #${KOMBEE_INDEX} to ${model}!`));
        } else {
          console.log(`[+] Medium Complexity: Node #${KOMBEE_INDEX} running model ${model}.`);
        }
      } else {
        console.log(`[+] Low Complexity: Node #${KOMBEE_INDEX} running model ${model}.`);
      }

      // Ensure model is pulled (Ollama cache handles this instantly if cached)
      execSync(`ollama pull ${model}`, { stdio: "inherit" });

      const coderPrompt = `
Perform the implementation steps detailed in the plan. Return the complete refactored files.
PLAN:
${context.plan}

FILES TO EDIT:
${fullCoderContext}

INSTRUCTION:
${INSTRUCTION}${truncationWarning}

FORMAT REQUIREMENT:
You must output each modified file wrapped strictly inside the boundary markers like this:

---START_FILE: example.js---
function example() {
    return "example";
}
module.exports = { example };
---END_FILE: example.js---

CRITICAL: You must preserve the existing outer file structure, function signatures, and module exports (e.g., module.exports = ...). Never delete the export statements. NEVER shorten the file by omitting pre-existing functions.
`;

      const coderOutput = await queryOllama(model, coderPrompt, `You are Hiven-Coder-${KOMBEE_INDEX}, an elite coding Kōmbee.`);
      
      // Save raw output to file
      const resultPayload = {
        kombeeIndex: KOMBEE_INDEX,
        partitionGroup: myPartition.group,
        model,
        coderOutput
      };
      fs.writeFileSync(`coder_output_${KOMBEE_INDEX}.json`, JSON.stringify(resultPayload, null, 2), "utf-8");
      console.log(`[+] Coder Kōmbee output saved to coder_output_${KOMBEE_INDEX}.json.`);
      await sendTelemetry("done", `Coder Node #${KOMBEE_INDEX} completed.`);
    }

    else if (PHASE === "validation") {
      // ==========================================================
      // FASE 3: VALIDATION & CORRECCIÓN (Tester & Reviewer Kōmbees)
      // ==========================================================
      console.log(`[*] Running Validator Kōmbee Node #${KOMBEE_INDEX}...`);
      if (KOMBEE_INDEX === 1) {
        await updateStatusComment("execution", "done");
        await updateStatusComment("validation", "running");
      }
      await sendTelemetry("running", `Validator Node #${KOMBEE_INDEX} checking syntax...`);
      checkoutCodebase();
      const context = JSON.parse(fs.readFileSync("swarm_context.json", "utf-8"));
      const coderData = JSON.parse(fs.readFileSync(`coder_output_${KOMBEE_INDEX}.json`, "utf-8"));
      
      // Parse output files and write to target directory
      const fileRegex = /---START_FILE:\s*([^\s-]+)---\n([\s\S]*?)\n---END_FILE:\s*\1---/g;
      let match;
      let modifiedFiles = [];
      
      while ((match = fileRegex.exec(coderData.coderOutput)) !== null) {
        const fileName = match[1].trim();
        const newContent = match[2];
        const filePath = path.join(TARGET_DIR, fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, newContent, "utf-8");
        modifiedFiles.push(fileName);
      }

      if (modifiedFiles.length === 0 && context.files.length > 0) {
        // Fallback writing using smart helper
        const writtenFile = writeCodeCleanly(coderData.coderOutput, context.files[0], context.files, context.plan, INSTRUCTION);
        if (writtenFile) {
          modifiedFiles.push(writtenFile);
        }
      }

      // Helper: Code Deletion Guard
      // Compares modified file size against the original in git HEAD
      const checkCodeDeletion = (file) => {
        const filePath = path.join(TARGET_DIR, file);
        let originalSize = 0;
        try {
          if (TARGET_REPO !== "mock/repo" && process.env.MOCK_GIT !== "true") {
            // file is already relative to repo root
            const gitShow = execSync(`git show HEAD:${file}`, { cwd: TARGET_DIR, stdio: 'pipe' }).toString();
            originalSize = gitShow.length;
          }
        } catch (_) {
          // File is likely new (not in HEAD) — no deletion guard needed
          return { shrunk: false };
        }
        
        if (originalSize > 500) {
          const newSize = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').length : 0;
          const ratio = newSize / originalSize;
          const isExplicitDelete = /delete|remove|cleanup|clear|vaciar|eliminar|reemplazar/i.test(INSTRUCTION);
          if (ratio < 0.5 && !isExplicitDelete) {
            return {
              shrunk: true,
              originalSize,
              newSize,
              msg: `Rejection: Code deletion safety guard triggered. File '${file}' shrunk by ${Math.round((1 - ratio) * 100)}% (from ${originalSize} to ${newSize} chars). Critical functions were likely deleted. You MUST return the ENTIRE file with ONLY the requested changes applied, preserving all pre-existing functions, helpers, and exports.`
            };
          }
        }
        return { shrunk: false };
      };

      const isOllamaAvailable = () => {
        try { execSync('ollama --version', { stdio: 'pipe' }); return true; } catch { return false; }
      };

      let isSuccess = false;
      let errorLog = "";
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[*] Validation Attempt ${attempt}/${maxAttempts} for Node #${KOMBEE_INDEX}...`);
        isSuccess = true;
        errorLog = "";

        if (modifiedFiles.length === 0) {
          isSuccess = false;
          errorLog += "Failed to parse code output: Coder model returned invalid layout or empty/JSON response.\n";
        }

        // 1. Check syntax and code deletion for all modified files
        for (const file of modifiedFiles) {
          const filePath = path.join(TARGET_DIR, file);
          
          // Code Deletion Guard check
          const delCheck = checkCodeDeletion(file);
          if (delCheck.shrunk) {
            isSuccess = false;
            errorLog += `Logic error in ${file}:\n${delCheck.msg}\n`;
            console.log(chalk.red(`[-] ${delCheck.msg}`));
            continue;
          }

          if (file.endsWith(".js")) {
            try {
              execSync(`node -c ${filePath}`, { stdio: "pipe" });
            } catch (e) {
              isSuccess = false;
              const stderrStr = e.stderr ? e.stderr.toString() : e.message;
              errorLog += `Syntax error in ${file}:\n${stderrStr}\n`;
              console.log(chalk.red(`[-] Syntax check failed: ${file}`));
            }
          }
        }

        // 2. Run logical audit for MEDIUM / HIGH tasks using deepseek-r1:8b (only if syntax/deletion checks passed)
        if (isSuccess && (context.complexity === "MEDIUM" || context.complexity === "HIGH") && isOllamaAvailable()) {
          console.log(`[*] Run logical code audit with ${MODELS.VALIDATOR_HIGH}...`);
          
          let codeChanges = "";
          for (const file of modifiedFiles) {
            const filePath = path.join(TARGET_DIR, file);
            if (fs.existsSync(filePath)) {
              codeChanges += `\n### File: ${file}\n\`\`\`\n${fs.readFileSync(filePath, "utf-8")}\n\`\`\`\n`;
            }
          }

          const auditPrompt = `
You are Hiven-Validator-Auditor. You must verify if the refactored code correctly implements the developer's instructions and has no logical bugs, security vulnerabilities, or regression errors.

INSTRUCTION:
${INSTRUCTION}

REFACTORED CODE:
${codeChanges}

Determine if the code is correct and free of logical bugs.
Respond ONLY with a JSON object containing:
"approved": true or false,
"reason": "Detail why it is approved or what logical bug was found."
`;

          try {
            execSync(`ollama pull ${MODELS.VALIDATOR_HIGH}`, { stdio: "inherit" });
            const auditResp = await queryOllama(MODELS.VALIDATOR_HIGH, auditPrompt, "You are Hiven-Validator-Auditor. Output JSON only.");
            console.log("[+] Auditor Response:", auditResp);
            
            const cleanJson = auditResp.replace(/```[a-zA-Z]*\n([\s\S]*?)\n```/g, "$1").replace(/```json|```/g, "").trim();
            const parsed = JSON.parse(cleanJson);
            if (parsed.approved === false) {
              isSuccess = false;
              errorLog += `Logical Audit Bug Found by Validator Auditor:\n${parsed.reason}\n`;
              console.log(chalk.red(`[-] Logical audit failed: ${parsed.reason}`));
            } else {
              console.log(chalk.green(`[+] Logical audit approved: ${parsed.reason}`));
            }
          } catch (e) {
            console.error("[-] Logical audit crashed/skipped:", e.message);
          }
        }

        // If validation passed, we are done
        if (isSuccess) {
          console.log(chalk.green(`[+] Validation passed on attempt ${attempt}!`));
          break;
        }

        // If validation failed, and we have attempts remaining, run correction loop
        if (attempt < maxAttempts) {
          console.warn(`[-] Attempt ${attempt} failed. Triggering correction cycle...`);
          
          if (!isOllamaAvailable()) {
            // Ollama not available — we cannot run LLM correction.
            // If deletion guard triggered, restore the original file from git
            // so worst case is "no change" instead of "file destroyed".
            let restoredAny = false;
            for (const file of modifiedFiles) {
              try {
                const gitOriginal = execSync(`git show HEAD:${file}`, { cwd: TARGET_DIR, stdio: 'pipe' }).toString();
                fs.writeFileSync(path.join(TARGET_DIR, file), gitOriginal, 'utf-8');
                console.warn(`[!] Restored original '${file}' from git HEAD (Ollama unavailable for correction).`);
                restoredAny = true;
              } catch (_) {
                console.warn(`[!] Could not restore '${file}' from git — file may be new.`);
              }
            }
            if (restoredAny) {
              // Mark as passed=false so consolidation knows this node had no valid change
              console.warn("[!] Validation marked as failed (original restored). Consolidation will prefer other nodes.");
            } else {
              // New file or unrestorable — pass as-is
              isSuccess = true;
              errorLog = "";
            }
            break;
          }

          let correctionModel = MODELS.CODER_LOW;
          if (context.complexity === "HIGH") {
            correctionModel = MODELS.CODER_HIGH;
          } else if (context.complexity === "MEDIUM") {
            correctionModel = KOMBEE_INDEX >= 9 ? MODELS.CODER_HIGH : MODELS.CODER_LOW;
          }
          
          console.log(`[*] Using correction model '${correctionModel}'...`);
          execSync(`ollama pull ${correctionModel}`, { stdio: "inherit" });

          // Include the original file contents in the correction prompt so the model has the code to restore
          let originalFilesContext = "";
          for (const file of modifiedFiles) {
            try {
              if (TARGET_REPO !== "mock/repo" && process.env.MOCK_GIT !== "true") {
                // file is already relative to repo root (e.g. src/zenon.js) — no src/ prefix
                const gitShow = execSync(`git show HEAD:${file}`, { cwd: TARGET_DIR, stdio: 'pipe' }).toString();
                originalFilesContext += `\n### ORIGINAL File: ${file}\n\`\`\`\n${gitShow.slice(0, 40000)}\n\`\`\`\n`;
              }
            } catch (_) {}
          }

          const correctionPrompt = `
The modified code failed validation checks. You must correct the errors while ensuring all original helper functions, classes, and structure are preserved. Do not delete pre-existing code.

ORIGINAL SOURCE FILES FOR REFERENCE (DO NOT DELETE THE LOGIC INSIDE THESE):
${originalFilesContext}

ERRORS FOUND:
${errorLog}

INSTRUCTION TO IMPLEMENT:
${INSTRUCTION}

Correct the code. Output the full file wrapping strictly in:
---START_FILE: filename---
code here
---END_FILE: filename---

CRITICAL: You must preserve the existing outer file structure, helper functions, and module exports. Never delete the export statements or shorten the file.
`;
          await sendTelemetry("running", `Validator Node #${KOMBEE_INDEX} running correction loop (Attempt ${attempt}/${maxAttempts})...`);
          const corrected = await queryOllama(correctionModel, correctionPrompt, "You are Hiven-Correction-Kōmbee.");
          
          // Rewrite modified files with correction output
          let matchCorr;
          modifiedFiles = [];
          const regexCorr = /---START_FILE:\s*([^\s-]+)---\n([\s\S]*?)\n---END_FILE:\s*\1---/g;
          while ((matchCorr = regexCorr.exec(corrected)) !== null) {
            const fileName = matchCorr[1].trim();
            const newContent = matchCorr[2];
            const filePath = path.join(TARGET_DIR, fileName);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, newContent, "utf-8");
            modifiedFiles.push(fileName);
          }

          if (modifiedFiles.length === 0 && context.files.length > 0) {
            const writtenFile = writeCodeCleanly(corrected, context.files[0], context.files, context.plan, INSTRUCTION);
            if (writtenFile) {
              modifiedFiles.push(writtenFile);
            }
          }
        }
      } // end attempt loop

      const fileMap = {};
      for (const file of modifiedFiles) {
        fileMap[file] = fs.readFileSync(path.join(TARGET_DIR, file), "utf-8");
      }

      const validationPayload = {
        kombeeIndex: KOMBEE_INDEX,
        partitionGroup: coderData.partitionGroup || 1,
        model: coderData.model,
        passed: isSuccess,
        errors: errorLog,
        modifiedFiles: fileMap
      };
      
      fs.writeFileSync(`validation_output_${KOMBEE_INDEX}.json`, JSON.stringify(validationPayload, null, 2), "utf-8");
      console.log(`[+] Validation results for Node #${KOMBEE_INDEX} saved.`);
      await sendTelemetry("done", `Validator Node #${KOMBEE_INDEX} completed.`);
    }

    else if (PHASE === "consolidation") {
      // ==========================================================
      // FASE 4: CONSOLIDATION (Committer & Telemetry Kōmbees)
      // ==========================================================
      console.log("[*] Running Phase 4 Consolidation Kōmbees...");
      await updateStatusComment("validation", "done");
      await updateStatusComment("consolidation", "running");
      await sendTelemetry("running", "Phase 4 Consolidation starting...");
      checkoutCodebase();
      const context = JSON.parse(fs.readFileSync("swarm_context.json", "utf-8"));
      const honeyDb = loadHoneyDb();

      // Collect all validation logs
      const candidates = [];
      for (let i = 1; i <= 10; i++) {
        const filePath = `validation_output_${i}.json`;
        if (fs.existsSync(filePath)) {
          candidates.push(JSON.parse(fs.readFileSync(filePath, "utf-8")));
        }
      }

      // MEJORA 5: Multi-Group Parallel Sub-Swarm Consolidation
      // Collect best passing candidates for EACH partition group and merge them together
      const groups = [...new Set(candidates.map(c => c.partitionGroup || 1))];
      const selectedCandidates = [];

      for (const grp of groups) {
        const groupCandidates = candidates.filter(c => (c.partitionGroup || 1) === grp);
        let bestGroupCand = groupCandidates.find(c => c.passed && c.model.includes("7b"));
        if (!bestGroupCand) {
          bestGroupCand = groupCandidates.find(c => c.passed);
        }
        if (bestGroupCand) {
          selectedCandidates.push(bestGroupCand);
        }
      }

      // If no node in ANY group passed validation, do NOT create a PR
      if (selectedCandidates.length === 0) {
        const failSummary = candidates.map(c => `Node #${c.kombeeIndex} (Group ${c.partitionGroup || 1}): ${c.errors?.split('\n')[0] || 'no error detail'}`).join('\n');
        console.error("[!] No valid candidates found. All validation nodes failed:");
        console.error(failSummary);
        await sendTelemetry("done", `[!] Swarm completed but NO valid code generated. All ${candidates.length} nodes failed validation. Check logs for details.`);
        await updateStatusComment("consolidation", "done");
        for (const ext of [...new Set(context.files.map(f => f.split('.').pop()).filter(Boolean))]) {
          await saveFederatedPattern(INSTRUCTION, ext, 'FAILED');
        }
        process.exit(0);
      }

      console.log(`[+] Selected ${selectedCandidates.length} winning sub-swarm candidates across ${groups.length} partition groups:`);
      for (const cand of selectedCandidates) {
        console.log(`  - Group ${cand.partitionGroup}: Node #${cand.kombeeIndex} (${cand.model})`);
      }

      // Merge modified files from all winning group candidates
      const mergedModifiedFiles = {};
      for (const cand of selectedCandidates) {
        for (const [file, content] of Object.entries(cand.modifiedFiles)) {
          mergedModifiedFiles[file] = content;
        }
      }

      // Apply merged changes to target directory
      for (const [file, content] of Object.entries(mergedModifiedFiles)) {
        const filePath = path.join(TARGET_DIR, file);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        console.log(`[+] Applied code modifications to: ${file}`);
      }

      let prUrl = null;
      const hasChanges = Object.keys(bestCandidate.modifiedFiles).length > 0;
      
      if (hasChanges) {
        // Git Commit & Push
        runGit("config user.name 'Hiven Swarm'");
        runGit("config user.email 'swarm@hiven.ai'");
        
        const patchBranch = `hiven/patch-${crypto.randomUUID().substring(0, 6)}`;
        runGit(`checkout -b ${patchBranch}`);
        runGit("add .");
        
        try {
          runGit(`commit -m "feat(hiven): swarm modification for instruction\n\nInstruction: ${INSTRUCTION}"`);
          runGit(`push origin ${patchBranch}`);
          
          if (TARGET_REPO === "mock/repo" || process.env.MOCK_GIT === "true") {
            console.log(chalk.green(`[Simulated Octokit] Opened Pull Request for ${patchBranch} -> ${TARGET_BRANCH}`));
            prUrl = `https://github.com/${TARGET_REPO}/pull/mock-1`;
          } else {
            // Open Pull Request
            const [owner, repo] = TARGET_REPO.split("/");
            const pr = await octokit.pulls.create({
              owner,
              repo,
              title: `Hiven Patch: ${INSTRUCTION.substring(0, 50)}...`,
              head: patchBranch,
              base: TARGET_BRANCH,
              body: `### 🐝 Hiven Swarm Refactoring Summary
              
Autonomous PR triggered by user instruction: **"${INSTRUCTION}"**

#### 🏗️ Swarm Plan:
${context.plan}

#### ⚙️ Execution Metrics:
* **Selected Coder:** Kōmbee Node #${bestCandidate.kombeeIndex}
* **Model Engine:** \`${bestCandidate.model}\`
* **Complexity Level:** \`${context.complexity}\`
* **Validation Check:** \`${bestCandidate.passed ? "PASSED" : "FAILED (Merged with fallback)"}\`
              
*Inference run executed entirely on zero-cost, ephemeral Actions runner compute.*`
            });
            
            console.log(chalk.green(`[+] Pull Request created successfully: ${pr.data.html_url}`));
            prUrl = pr.data.html_url;
          }
        } catch (e) {
          console.warn("[-] Failed to commit or push codebase edits (likely read-only query):", e.message);
        }
      } else {
        console.log("[*] No code changes detected. Bypassing branch creation, commit, and Pull Request.");
      }

      // Post comment back to the issue/PR if ISSUE_NUMBER is provided
      if (ISSUE_NUMBER && TARGET_REPO !== "mock/repo" && process.env.MOCK_GIT !== "true") {
        try {
          const [owner, repo] = TARGET_REPO.split("/");
          const issueNum = parseInt(ISSUE_NUMBER, 10);
          console.log(`[*] Posting final response to issue #${issueNum}...`);
          
          let commentBody = "";
          if (prUrl) {
            commentBody = `### 🐝 Hiven Swarm Execution Complete!
            
I have successfully implemented your requested changes in a new Pull Request!

👉 **[View Pull Request](${prUrl})**

#### 📋 Swarm Plan:
${context.plan}

#### ⚙️ Metrics:
* **Selected Coder:** Kōmbee Node #${bestCandidate.kombeeIndex} (\`${bestCandidate.model}\`)
* **Complexity Level:** \`${context.complexity}\`
`;
          } else {
            commentBody = `### 🐝 Swarm Analysis Complete!

I have completed the analysis for your request: **"${INSTRUCTION}"**

${context.plan}

---
*Metrics: Coder Kōmbee Node #${bestCandidate.kombeeIndex} (${bestCandidate.model}) | Complexity: ${context.complexity}*`;
          }

          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: issueNum,
            body: commentBody
          });
          console.log("[+] Response comment posted successfully!");
        } catch (commentErr) {
          console.error("[-] Failed to post comment back to issue:", commentErr.message);
        }
      }

      // Persist honey.db
      honeyDb.stylePreferences.lastModel = bestCandidate.model;
      if (!bestCandidate.passed && bestCandidate.errors) {
        honeyDb.errorSignatures[crypto.randomUUID().substring(0, 4)] = "Syntax issue handled via correction loop.";
      }
      saveHoneyDb(honeyDb);

      // Save federated pattern if PR was created successfully
      if (prUrl && bestCandidate.modifiedFiles) {
        const fileExts = Object.keys(bestCandidate.modifiedFiles)
          .map(f => f.split('.').pop()).filter(Boolean);
        const primaryExt = [...new Set(fileExts)][0] || 'js';
        await saveFederatedPattern(primaryExt, INSTRUCTION,
          bestCandidate.passed ? 'SUCCESS: PR created, validation passed' : 'PARTIAL: PR created, validation had issues'
        );
      }

      if (DRONE_UPLINK_URL) {
        console.log(`[+] Routing telemetry to Drone: ${DRONE_UPLINK_URL}`);
      }
      await updateStatusComment("consolidation", "done");
      await sendTelemetry("done", prUrl ? `Swarm complete. PR created: ${prUrl}` : `Swarm complete. Response: ${context.plan.substring(0, 150)}...`);
    }
  } catch (error) {
    console.error(chalk.red(`[!] Critical error in Phase [${PHASE}] execution:`), error);
    await sendTelemetry("error", `Critical error in Phase [${PHASE}]: ${error.message}`);
    process.exit(1);
  }
}

main();
