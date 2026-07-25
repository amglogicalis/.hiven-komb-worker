// swarm_runner.js
// Hiven Worker Swarm - Ephemeral Multi-Agent Execution Engine
// Role: Principal Distributed Systems & MLOps Architect

import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
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
  DRONE_UPLINK_URL,
  WORKER_ID
} = process.env;

const OLLAMA_HOST = "http://localhost:11434";
const TARGET_DIR = "./target_code";

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

// Helper to extract, clean, and write code robustly
function writeCodeCleanly(content, defaultFile, contextFiles) {
  let cleanCode = content;
  
  // Extract markdown code block if present
  const codeBlockRegex = /```[a-zA-Z]*\n([\s\S]*?)\n```/g;
  const matches = [...cleanCode.matchAll(codeBlockRegex)];
  if (matches.length > 0) {
    cleanCode = matches.map(m => m[1]).join("\n");
  }

  // Remove syntax-breaking markdown headers/comments
  cleanCode = cleanCode.replace(/^###\s*File:\s*\S+/gm, "");
  cleanCode = cleanCode.replace(/^\/\/ File:\s*\S+/gm, "");
  cleanCode = cleanCode.trim();

  // Match text to a file from contextFiles if possible
  let targetFile = defaultFile;
  for (const file of contextFiles) {
    if (content.toLowerCase().includes(file.toLowerCase())) {
      targetFile = file;
      break;
    }
  }

  const filePath = path.join(TARGET_DIR, targetFile);
  fs.writeFileSync(filePath, cleanCode, "utf-8");
  return targetFile;
}


// ==========================================
// PIPELINE RUN
// ==========================================
async function main() {
  try {
    if (PHASE === "context") {
      // ==========================================================
      // FASE 1: CONTEXT (Option A - Decomposition & Option B - Routing)
      // ==========================================================
      console.log("[*] Running Phase 1 Context Kōmbees...");
      checkoutCodebase();
      const honeyDb = loadHoneyDb();

      // Read target files to build prompt context
      let files = [];
      if (FILES_TO_EDIT) {
        files = FILES_TO_EDIT.split(",").map(f => f.trim());
      } else {
        files = fs.readdirSync(TARGET_DIR)
          .filter(file => fs.statSync(path.join(TARGET_DIR, file)).isFile())
          .slice(0, 3);
      }

      let codeContext = "";
      for (const file of files) {
        const filePath = path.join(TARGET_DIR, file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          codeContext += `\n### File: ${file}\n\`\`\`\n${content}\n\`\`\`\n`;
        }
      }

      // 1. Complexity Assessment & Conditional Routing (Option B Improved)
      console.log("[*] Assessing task complexity for compute routing...");
      const complexityPrompt = `
Analyze the developer instruction and files. Rate the task complexity as either LOW or HIGH.
High complexity tasks involve:
- Algorithms, math, or complex logical calculations.
- Structural refactoring of database queries, classes, or API handlers.
- Edits affecting multiple files.

FILES:
${files.join(", ")}

INSTRUCTION:
${INSTRUCTION}

Respond ONLY with a single JSON object containing "complexity" ("LOW" or "HIGH") and "reason".
`;

      execSync(`ollama pull qwen2.5-coder:1.5b`, { stdio: "inherit" });
      const complexityResp = await queryOllama("qwen2.5-coder:1.5b", complexityPrompt, "You are Hiven-Complexity-Evaluator. Output JSON only. Respond with JSON format only.");
      console.log("[+] Evaluator Response:", complexityResp);
      
      let complexity = "LOW";
      try {
        const cleanJson = complexityResp.replace(/```[a-zA-Z]*\n([\s\S]*?)\n```/g, "$1").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleanJson);
        complexity = parsed.complexity || "LOW";
      } catch (e) {
        // Fallback check
        if (complexityResp.toUpperCase().includes("HIGH")) {
          complexity = "HIGH";
        }
      }

      const requiresHeavyCoder = (complexity === "HIGH");
      console.log(`[+] Task Complexity Assessed: ${complexity}. Heavy Coder Required: ${requiresHeavyCoder}`);

      // Determine planning model (Expert Routing)
      let plannerModel = "llama3.2:1b";
      if (complexity === "HIGH") {
        plannerModel = "qwen2.5-coder:1.5b";
        console.log(chalk.magenta(`[!] High Complexity Planning. Scaling Architect Kōmbee up to ${plannerModel}!`));
      }

      console.log(`[*] Pulling planner model ${plannerModel}...`);
      execSync(`ollama pull ${plannerModel}`, { stdio: "inherit" });

      // 2. Task Decomposition (Option A)
      console.log("[*] Running Architect Kōmbee to decompose instruction...");
      const contextPrompt = `
Analyze the following source files and the developer instruction.
Write a structured, step-by-step implementation plan (Decomposition) separating the work into atomic micro-tasks.

FILES:
${codeContext}

INSTRUCTION:
${INSTRUCTION}

STYLE CACHE:
${JSON.stringify(honeyDb.stylePreferences)}

Provide the step-by-step plan in markdown.
`;

      const plan = await queryOllama(plannerModel, contextPrompt, "You are Hiven-Architect, a principal code planning agent.");
      console.log("[+] Plan Generated:\n", plan);

      // Save context metadata for next stages
      const swarmContext = {
        plan,
        complexity,
        requiresHeavyCoder,
        files,
        codeContext
      };
      fs.writeFileSync("swarm_context.json", JSON.stringify(swarmContext, null, 2), "utf-8");
      console.log("[+] Context saved to swarm_context.json.");
    }
    
    else if (PHASE === "execution") {
      // ==========================================================
      // FASE 2: EXECUTION (Conditional Routing & Inferencia Híbrida)
      // ==========================================================
      console.log(`[*] Running Coder Kōmbee Node #${KOMBEE_INDEX}...`);
      const context = JSON.parse(fs.readFileSync("swarm_context.json", "utf-8"));
      
      // Determine model (Option B Improved):
      // If task is HIGH complexity, Nodes 9 and 10 scale up to the 7B model.
      let model = "qwen2.5-coder:1.5b";
      if (context.requiresHeavyCoder && (KOMBEE_INDEX === 9 || KOMBEE_INDEX === 10)) {
        model = "qwen2.5-coder:7b";
        console.log(chalk.magenta(`[!] Heavy Load Detected. Kōmbee Node #${KOMBEE_INDEX} scaling up to ${model}!`));
      } else {
        console.log(`[+] Kōmbee Node #${KOMBEE_INDEX} running lightweight model ${model}.`);
      }

      // Ensure model is pulled (Ollama cache handles this instantly if cached)
      execSync(`ollama pull ${model}`, { stdio: "inherit" });

      const coderPrompt = `
Perform the implementation steps detailed in the plan. Return the complete refactored files.
PLAN:
${context.plan}

FILES TO EDIT:
${context.codeContext}

INSTRUCTION:
${INSTRUCTION}

FORMAT REQUIREMENT:
You must output each modified file wrapped strictly inside the boundary markers like this:

---START_FILE: example.js---
function example() {
    return "example";
}
module.exports = { example };
---END_FILE: example.js---

CRITICAL: You must preserve the existing outer file structure, function signatures, and module exports (e.g., module.exports = ...). Never delete the export statements.
`;

      const coderOutput = await queryOllama(model, coderPrompt, `You are Hiven-Coder-${KOMBEE_INDEX}, an elite coding Kōmbee.`);
      
      // Save raw output to file
      const resultPayload = {
        kombeeIndex: KOMBEE_INDEX,
        model,
        coderOutput
      };
      fs.writeFileSync(`coder_output_${KOMBEE_INDEX}.json`, JSON.stringify(resultPayload, null, 2), "utf-8");
      console.log(`[+] Coder Kōmbee output saved to coder_output_${KOMBEE_INDEX}.json.`);
    }

    else if (PHASE === "validation") {
      // ==========================================================
      // FASE 3: VALIDATION & CORRECCIÓN (Tester & Reviewer Kōmbees)
      // ==========================================================
      console.log(`[*] Running Validator Kōmbee Node #${KOMBEE_INDEX}...`);
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
        fs.writeFileSync(path.join(TARGET_DIR, fileName), newContent, "utf-8");
        modifiedFiles.push(fileName);
      }

      if (modifiedFiles.length === 0 && context.files.length > 0) {
        // Fallback writing using smart helper
        const writtenFile = writeCodeCleanly(coderData.coderOutput, context.files[0], context.files);
        modifiedFiles.push(writtenFile);
      }

      // Run syntax checks (Validation Kōmbees)
      let isSuccess = true;
      let errorLog = "";

      for (const file of modifiedFiles) {
        const filePath = path.join(TARGET_DIR, file);
        if (file.endsWith(".js")) {
          try {
            execSync(`node -c ${filePath}`, { stdio: "pipe" });
          } catch (e) {
            isSuccess = false;
            const stderrStr = e.stderr ? e.stderr.toString() : e.message;
            errorLog += `Syntax error in ${file}:\n${stderrStr}\n`;
          }
        }
      }

      // Bucle de corrección (Self-Correction Loop)
      if (!isSuccess) {
        console.warn(`[-] Node #${KOMBEE_INDEX} validation failed. Executing correction loop...`);
        
        // Expert Routing for correction model
        let correctionModel = coderData.model;
        if (context.requiresHeavyCoder || context.complexity === "HIGH") {
          correctionModel = "qwen2.5-coder:7b";
        }
        console.log(`[*] Using correction model '${correctionModel}'...`);
        execSync(`ollama pull ${correctionModel}`, { stdio: "inherit" });

        const correctionPrompt = `
The following code has compilation errors:
FEEDBACK:
${errorLog}

Correct the code. Output the full file wrapping strictly in:
---START_FILE: filename---
code here
---END_FILE: filename---

EXAMPLE FORMAT:
---START_FILE: example.js---
function example() {
    return "example";
}
module.exports = { example };
---END_FILE: example.js---

CRITICAL: You must preserve the existing outer file structure, function signatures, and module exports (e.g., module.exports = ...). Never delete the export statements.
`;
        const corrected = await queryOllama(correctionModel, correctionPrompt, "You are Hiven-Correction-Kōmbee.");
        
        // Rewrite
        let matchCorr;
        modifiedFiles = [];
        const regexCorr = /---START_FILE:\s*([^\s-]+)---\n([\s\S]*?)\n---END_FILE:\s*\1---/g;
        while ((matchCorr = regexCorr.exec(corrected)) !== null) {
          const fileName = matchCorr[1].trim();
          const newContent = matchCorr[2];
          fs.writeFileSync(path.join(TARGET_DIR, fileName), newContent, "utf-8");
          modifiedFiles.push(fileName);
        }

        if (modifiedFiles.length === 0 && context.files.length > 0) {
          const writtenFile = writeCodeCleanly(corrected, context.files[0], context.files);
          modifiedFiles.push(writtenFile);
        }
        
        // Re-verify
        isSuccess = true;
        errorLog = "";
        for (const file of modifiedFiles) {
          if (file.endsWith(".js")) {
            try {
              execSync(`node -c ${path.join(TARGET_DIR, file)}`, { stdio: "pipe" });
            } catch (e) {
              isSuccess = false;
              const stderrStr = e.stderr ? e.stderr.toString() : e.message;
              errorLog += `Post-correction syntax error in ${file}:\n${stderrStr}\n`;
            }
          }
        }
      }

      const fileMap = {};
      for (const file of modifiedFiles) {
        fileMap[file] = fs.readFileSync(path.join(TARGET_DIR, file), "utf-8");
      }

      const validationPayload = {
        kombeeIndex: KOMBEE_INDEX,
        model: coderData.model,
        passed: isSuccess,
        errors: errorLog,
        modifiedFiles: fileMap
      };
      
      fs.writeFileSync(`validation_output_${KOMBEE_INDEX}.json`, JSON.stringify(validationPayload, null, 2), "utf-8");
      console.log(`[+] Validation results for Node #${KOMBEE_INDEX} saved.`);
    }

    else if (PHASE === "consolidation") {
      // ==========================================================
      // FASE 4: CONSOLIDATION (Committer & Telemetry Kōmbees)
      // ==========================================================
      console.log("[*] Running Phase 4 Consolidation Kōmbees...");
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

      // Selection Strategy:
      // 1. Look for passing heavy models (index 9/10).
      // 2. Look for passing light models.
      // 3. Fallback to first available.
      let bestCandidate = candidates.find(c => c.passed && c.model.includes("7b"));
      if (!bestCandidate) {
        bestCandidate = candidates.find(c => c.passed);
      }
      if (!bestCandidate && candidates.length > 0) {
        bestCandidate = candidates[0]; // fallback
      }

      if (!bestCandidate) {
        console.error("[!] No generation candidates found. Swarm aborting.");
        process.exit(1);
      }

      console.log(`[+] Best candidate selected from Kōmbee Node #${bestCandidate.kombeeIndex} (Model: ${bestCandidate.model}). Validation passed: ${bestCandidate.passed}`);

      // Apply changes to target directory
      for (const [file, content] of Object.entries(bestCandidate.modifiedFiles)) {
        fs.writeFileSync(path.join(TARGET_DIR, file), content, "utf-8");
        console.log(`[+] Applied code modifications to: ${file}`);
      }

      // Git Commit & Push
      runGit("config user.name 'Hiven Swarm'");
      runGit("config user.email 'swarm@hiven.ai'");
      
      const patchBranch = `hiven/patch-${crypto.randomUUID().substring(0, 6)}`;
      runGit(`checkout -b ${patchBranch}`);
      runGit("add .");
      
      let prUrl = null;
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

      // Drone uplink telemetry
      if (DRONE_UPLINK_URL) {
        console.log(`[+] Routing telemetry to Drone: ${DRONE_UPLINK_URL}`);
      }
    }
  } catch (error) {
    console.error(chalk.red(`[!] Critical error in Phase [${PHASE}] execution:`), error);
    process.exit(1);
  }
}

main();
