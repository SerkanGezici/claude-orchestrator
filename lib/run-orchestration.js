#!/usr/bin/env node
'use strict';

/**
 * Claude-Orchestrator Standalone Runner
 *
 * Self-contained — all requires are local (no config.json, no external PROJECT_ROOT).
 *
 * 3 MODES:
 *
 * 1. HEALTH CHECK:
 *    node run-orchestration.js --health-check
 *
 * 2. SINGLE TURN (for Claude active participation):
 *    node run-orchestration.js --single-turn --turn 1 --task "task" --workspace "/path"
 *    node run-orchestration.js --single-turn --turn 2 --task "task" --workspace "/path" --prev-reports /tmp/prev.json
 *
 * 3. CONVERGENCE CHECK:
 *    node run-orchestration.js --check-convergence /tmp/all-reports.json
 */

const path = require('path');
const fs   = require('fs');

// Local imports (self-contained)
const AIHealthChecker    = require('./health-checker');
const CodexWrapper       = require('./codex-wrapper');
const GeminiWrapper      = require('./gemini-wrapper');
const convergence        = require('./convergence');

// ========================
// TASK-TYPE DETECTION
// ========================

/**
 * Detect task type from text.
 * @param {string} task
 * @returns {'brainstorm'|'research'|'audit'}
 */
function detectTaskType(task) {
    // Research (check before brainstorm)
    const researchPatterns = [
        /araştır/i, /research/i, /investigate/i,
        /karşılaştırmalı\s+analiz/i, /state\s+of\s+the\s+art/i,
        /benchmark/i, /survey/i, /ne\s+fark/i
    ];
    for (const p of researchPatterns) {
        if (p.test(task)) return 'research';
    }

    // Audit signals
    const auditSignals = [
        /kapsaml[ıi]\s+analiz/i, /tarama\s+yap/i, /g[üu]venlik\s+(?:analiz|tara|kontrol|denet)/i,
        /kod\s+kalitesi/i, /code\s+review/i, /audit/i, /OWASP/i,
        /vulnerability/i, /dead\s+code/i, /lint/i
    ];
    for (const p of auditSignals) {
        if (p.test(task)) return 'audit';
    }

    // Brainstorm / architecture / feasibility
    const brainstormPatterns = [
        /mümkün\s*mü/i, /feasib/i, /brainstorm/i, /comparison/i,
        /karşılaştır/i, /entegrasyon/i, /mimari/i, /tasarla/i,
        /architecture/i, /design\s*decision/i, /trade.?off/i,
        /should\s+we/i, /how\s+can\s+we/i, /is\s+it\s+possible/i,
        /nasıl\s+(?:bağlan|entegre|birleştir)/i, /bridge/i,
        /alternatif/i, /alternative/i, /pros?\s+(?:and|&)\s+cons?/i,
        /yaklaşım/i, /approach/i, /strateji/i, /strategy/i
    ];
    for (const p of brainstormPatterns) {
        if (p.test(task)) return 'brainstorm';
    }

    return 'audit';
}

/**
 * Extract directory paths from task text.
 * @param {string} task
 * @returns {string[]}
 */
function extractPathsFromTask(task) {
    const paths = new Set();

    // Unix-style paths
    const unixMatches = task.match(/(?:\/(?:mnt|home|tmp|var|opt)\/[^\s"',;)}\]]+)/g) || [];
    for (const m of unixMatches) {
        paths.add(m.replace(/[.,;:!?)}\]]+$/, ''));
    }

    // Windows-style paths → convert to /mnt/...
    const winMatches = task.match(/[A-Z]:\\[^\s"',;)}\]]+/g) || [];
    for (const m of winMatches) {
        const clean = m.replace(/[.,;:!?)}\]]+$/, '');
        const drive = clean[0].toLowerCase();
        const rest  = clean.substring(2).replace(/\\/g, '/');
        paths.add(`/mnt/${drive}${rest}`);
    }

    // Validate
    const validated = [];
    for (const p of paths) {
        try {
            const stat = fs.statSync(p);
            validated.push(stat.isDirectory() ? p : path.dirname(p));
        } catch (_e) {
            console.error(`[path-extract] skipping non-existent: ${p}`);
        }
    }
    return [...new Set(validated)];
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const result = {
        task: '', workspace: process.cwd(), includeDirs: [],
        maxTurns: 10, threshold: 0.90,
        healthOnly: false, singleTurn: false, turn: 1,
        prevReportsFile: null, checkConvergenceFile: null,
        enableCodex: true, enableGemini: true
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--task':              result.task = args[++i] || ''; break;
            case '--workspace':         result.workspace = args[++i] || process.cwd(); break;
            case '--include-dirs':
                (args[++i] || '').split(',').forEach(d => { const t = d.trim(); if (t) result.includeDirs.push(t); });
                break;
            case '--max-turns':         result.maxTurns = parseInt(args[++i]) || 5; break;
            case '--threshold':         result.threshold = parseFloat(args[++i]) || 0.90; break;
            case '--health-check':      result.healthOnly = true; break;
            case '--single-turn':       result.singleTurn = true; break;
            case '--turn':              result.turn = parseInt(args[++i]) || 1; break;
            case '--prev-reports':      result.prevReportsFile = args[++i] || null; break;
            case '--check-convergence': result.checkConvergenceFile = args[++i] || null; break;
            case '--no-codex':          result.enableCodex = false; break;
            case '--no-gemini':         result.enableGemini = false; break;
        }
    }
    return result;
}

/**
 * Validate and normalize workspace path.
 */
function validateWorkspace(workspace) {
    let resolved = path.resolve(workspace);

    try { resolved = fs.realpathSync(resolved); }
    catch (err) {
        console.error(`[workspace-validation] FATAL: Workspace path not found: "${workspace}"`);
        console.error(`[workspace-validation] Error: ${err.message}`);
        process.exit(1);
    }

    try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            console.error(`[workspace-validation] FATAL: Not a directory: "${resolved}"`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[workspace-validation] FATAL: Cannot access: "${resolved}" - ${err.message}`);
        process.exit(1);
    }

    try {
        const entries = fs.readdirSync(resolved).slice(0, 15);
        console.error(`[workspace-validation] OK: "${resolved}"`);
        console.error(`[workspace-validation] Contents (first 15): ${entries.join(', ')}`);
        if (workspace !== resolved) {
            console.error(`[workspace-validation] NOTE: "${workspace}" -> "${resolved}"`);
        }
    } catch (_err) { /* non-critical */ }

    return resolved;
}

// ========================
// PROMPT BUILDERS
// ========================

function buildFirstTurnPrompt(workerName, config) {
    const taskType = config.taskType || detectTaskType(config.task);
    const includeDirsInfo = (config.includeDirs && config.includeDirs.length > 0)
        ? `\nAdditional directories you can access:\n${config.includeDirs.map(d => `  - ${d}`).join('\n')}\n`
        : '';

    // --- BRAINSTORM / RESEARCH MODE ---
    if (taskType === 'brainstorm' || taskType === 'research') {
        return `CRITICAL REQUIREMENTS:
1) RESPOND ENTIRELY IN ENGLISH
2) STAY FOCUSED on the specific question below — DO NOT audit the entire project
3) DO NOT investigate unrelated bugs, issues, or code quality problems
4) EVERY claim MUST have evidence (file:line or code snippet)
5) If you cannot access a file, say so — DO NOT hallucinate its contents

You are ${workerName.toUpperCase()} (Worker AI) in a multi-AI orchestration.
Other AIs (including Claude and ${workerName === 'gemini' ? 'Codex' : 'Gemini'}) are analyzing the same question independently.

===================================================
SPECIFIC QUESTION TO ANSWER (DO NOT DEVIATE):
===================================================

${config.task}

===================================================

===================================================
MANDATORY WORKSPACE CONSTRAINT:
You MUST ONLY analyze files within: ${config.workspace}
Do NOT perform web research. Do NOT analyze files outside this directory.
If you cannot access this directory, STOP and report: "ERROR: Wrong workspace"
===================================================

Primary workspace: ${config.workspace}
${includeDirsInfo}
INSTRUCTIONS:
- ONLY read files that are DIRECTLY relevant to the question above
- DO NOT scan the entire project for general issues
- Focus on: feasibility, architecture options, trade-offs, and implementation paths
- Reference specific files and code when supporting your analysis

=== REPORT FORMAT (MANDATORY) ===

SECTION 1: DETAILED ANALYSIS
Answer the specific question above with:
- Direct answer (yes/no/conditional + explanation)
- Key files and code relevant to the question (with file:line references)
- Feasibility assessment and blockers
- Recommended approaches with trade-offs

SECTION 2: STRUCTURED SUMMARY (MANDATORY - at the very end)
\`\`\`json
{
  "findings": [
    {
      "id": "ARCH-001",
      "title": "short keyword-focused title",
      "severity": "critical|high|medium|low",
      "category": "feasibility|architecture|blocker|recommendation",
      "evidence": "file.cs:42 - brief evidence description"
    }
  ]
}
\`\`\`

TITLE RULES: Keep titles SHORT (3-8 words), use KEY TECHNICAL TERMS.

FINAL REMINDER: Analyze ONLY files in ${config.workspace}. Do NOT deviate from the question above.

Your Report:`;
    }

    // --- AUDIT MODE ---
    const isGenericTask = /kapsaml[ıi]\s+analiz\s+et|comprehensive.*analy[sz]|guvenlik.*mimari.*performans/i.test(config.task);

    const taskFocusBlock = isGenericTask
        ? `COMPREHENSIVE ANALYSIS REQUIRED:
- Security vulnerabilities (input validation, XSS, CSRF, dependencies)
- Performance issues (bundle size, rendering, memory leaks)
- Architecture improvements (coupling, patterns, scalability)
- Code quality (maintainability, documentation, tests)`
        : `Focus your analysis EXCLUSIVELY on the task above. Do NOT perform a general audit.
Only investigate aspects directly related to the specified task.`;

    return `CRITICAL REQUIREMENTS:
1) RESPOND ENTIRELY IN ENGLISH
2) IF YOU CANNOT READ FILES: IMMEDIATELY report "ERROR: Cannot access files"
3) DO NOT HALLUCINATE - only report what you can verify
4) EVERY finding MUST have evidence (file:line or code snippet)

You are ${workerName.toUpperCase()} (Worker AI) in a multi-AI orchestration.
Other AIs (including Claude and ${workerName === 'gemini' ? 'Codex' : 'Gemini'}) are analyzing the same project independently.

===================================================
MANDATORY WORKSPACE CONSTRAINT:
You MUST ONLY analyze files within: ${config.workspace}
Do NOT perform web research. Do NOT analyze files outside this directory.
If you cannot access this directory, STOP and report: "ERROR: Wrong workspace"
===================================================

===================================================
YOUR TASK (DO NOT DEVIATE):
===================================================
${config.task}
===================================================

Workspace: ${config.workspace}
${includeDirsInfo}
${taskFocusBlock}

=== REPORT FORMAT (MANDATORY) ===

Your report MUST have exactly TWO sections:

SECTION 1: DETAILED ANALYSIS
Write your full analysis in natural language. Include detailed explanations,
evidence, code snippets, file references, and reasoning.

SECTION 2: STRUCTURED SUMMARY (MANDATORY - at the very end)
\`\`\`json
{
  "findings": [
    {
      "id": "SEC-001",
      "title": "short keyword-focused title",
      "severity": "critical|high|medium|low",
      "category": "security|architecture|performance|quality",
      "evidence": "file.cs:42 - brief evidence description"
    }
  ]
}
\`\`\`

TITLE RULES: Keep titles SHORT (3-8 words), use KEY TECHNICAL TERMS.
Severity: critical (exploitable/data loss), high (significant risk), medium (should fix), low (improvement).

FINAL REMINDER: Analyze ONLY files in ${config.workspace}. Stay focused on the task above.

Your Report:`;
}

function buildCritiqueTurnPrompt(workerName, config, prevReports) {
    const taskType = config.taskType || detectTaskType(config.task);

    let otherReportsText = '';
    for (const [name, data] of Object.entries(prevReports)) {
        if (name !== workerName && data && !data.failed) {
            otherReportsText += `\n--- ${name.toUpperCase()}'S REPORT ---\n`;
            otherReportsText += (data.report || '').substring(0, 8000);
            otherReportsText += '\n';
        }
    }

    const ownReport = prevReports[workerName];
    const ownText = ownReport && !ownReport.failed
        ? (ownReport.report || '').substring(0, 8000)
        : '[No previous report]';

    const focusReminder = `\nREMINDER: The original task was:\n${config.task}\nStay focused on THIS task. Do not drift into unrelated analysis.\n`;

    return `TURN ${config.turn}: ADVERSARIAL CROSS-REVIEW
${focusReminder}
You are ${workerName.toUpperCase()}. Your job is to STRESS-TEST the other reports, not to agree with them.

Workspace: ${config.workspace}

--- YOUR PREVIOUS REPORT ---
${ownText}

${otherReportsText}

ADVERSARIAL REVIEW PROTOCOL:
For EACH finding from other AIs, you MUST assign ONE verdict:
- CONFIRMED: You independently verified with YOUR OWN evidence (cite file:line)
- CHALLENGED: You found counter-evidence or the claim is wrong (cite file:line)
- INSUFFICIENT: Their evidence is too weak to confirm or deny

MANDATORY RULES:
- You MUST challenge at least 2 findings from other reports
- "I agree with everything" is NEVER acceptable — every report has weaknesses
- A finding that survives your challenge becomes STRONGER
- Look for: wrong file references, severity inflation, outdated claims, missing context
- If you simply rubber-stamp other reports, YOUR report adds ZERO value

PRODUCE ADVERSARIAL REVIEW with the SAME TWO-SECTION FORMAT:

SECTION 1: DETAILED ANALYSIS
1. YOUR FINDINGS: Reaffirm with stronger evidence, or withdraw with explanation
2. CHALLENGED FINDINGS: List each finding you dispute with counter-evidence
3. CONFIRMED FINDINGS: List findings you independently verified with your own evidence
4. NEW FINDINGS: Anything you found that nobody else reported
5. VERDICT TABLE: For each other AI's finding, state CONFIRMED/CHALLENGED/INSUFFICIENT

SECTION 2: STRUCTURED SUMMARY (MANDATORY - at the very end)
\`\`\`json
{
  "findings": [
    {
      "id": "SEC-001",
      "title": "short keyword-focused title",
      "severity": "critical|high|medium|low",
      "category": "${taskType === 'audit' ? 'security|architecture|performance|quality' : 'feasibility|architecture|blocker|recommendation'}",
      "evidence": "file.cs:42 - brief evidence description"
    }
  ]
}
\`\`\`

TITLE RULES: Keep titles SHORT (3-8 words), use KEY TECHNICAL TERMS.
Use SAME title wording as previous turn when the finding hasn't changed.

REQUIREMENTS: English only, evidence-based, both sections mandatory.

Your improved report:`;
}

// ========================
// OUTPUT VALIDATION
// ========================

/**
 * Validate worker output quality.
 * Returns { valid: boolean, reason: string }
 */
function _validateWorkerOutput(report, workerName) {
    if (!report || typeof report !== 'string') {
        return { valid: false, reason: 'empty or non-string response' };
    }

    // Too short — likely an error message or truncated
    if (report.length < 200) {
        return { valid: false, reason: `too short (${report.length} chars, need 200+)` };
    }

    // Check for error indicators
    const errorPatterns = [
        /ERROR:\s*Cannot access files/i,
        /I (?:cannot|can't|am unable to) (?:access|read|find)/i,
        /no files found/i
    ];
    for (const p of errorPatterns) {
        if (p.test(report)) {
            return { valid: false, reason: 'worker reported file access error' };
        }
    }

    // Check for JSON findings block (required for convergence)
    const hasJsonBlock = /```json\s*[\s\S]*?"findings"\s*:/m.test(report);
    if (!hasJsonBlock && report.length < 1000) {
        // Short report without JSON — likely off-topic or incomplete
        return { valid: false, reason: 'no JSON findings block and report is short' };
    }

    // If report is long enough (1000+) but no JSON, accept with warning
    // (some workers produce good text analysis without the JSON block)
    if (!hasJsonBlock) {
        console.error(`[validate] ${workerName}: no JSON block but report is ${report.length} chars — accepting`);
    }

    return { valid: true, reason: 'ok' };
}

/**
 * Check if worker report is relevant to the workspace.
 */
function _validateWorkspaceRelevance(report, workspace) {
    let entries;
    try { entries = fs.readdirSync(workspace).slice(0, 30); }
    catch { return { relevant: true, reason: 'cannot read workspace' }; }

    if (entries.length === 0) return { relevant: true, reason: 'empty workspace' };

    const reportLower = report.toLowerCase();
    const meaningfulEntries = entries.filter(e => !['node_modules', '.git', '.vscode', '.idea', 'dist', 'build'].includes(e));
    const checkEntries = meaningfulEntries.length > 0 ? meaningfulEntries : entries;
    const matchCount = checkEntries.filter(e => reportLower.includes(e.toLowerCase())).length;

    if (matchCount === 0) {
        return { relevant: false, reason: `Report mentions 0/${checkEntries.length} workspace entries. Likely wrong project.` };
    }
    return { relevant: true, reason: `${matchCount}/${checkEntries.length} workspace entries mentioned` };
}

/**
 * Soft check: does the report mention key terms from the task?
 */
function _validateTaskRelevance(report, task) {
    const stopWords = new Set([
        'this', 'that', 'with', 'from', 'have', 'will', 'should', 'could', 'would',
        'about', 'their', 'there', 'these', 'those', 'which', 'other', 'every',
        'project', 'analyze', 'analysis', 'check', 'review', 'kapsamli', 'analiz'
    ]);
    const taskWords = task.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4 && !stopWords.has(w));

    if (taskWords.length === 0) return { relevant: true, reason: 'no key terms to check' };

    const reportLower = report.toLowerCase();
    const found = taskWords.filter(w => reportLower.includes(w));
    const ratio = found.length / taskWords.length;

    if (ratio < 0.15) {
        return { relevant: false, reason: `Only ${found.length}/${taskWords.length} task keywords found (${(ratio * 100).toFixed(0)}%)` };
    }
    return { relevant: true, reason: `${found.length}/${taskWords.length} task keywords found (${(ratio * 100).toFixed(0)}%)` };
}

// ========================
// MODE 1: HEALTH CHECK
// ========================
async function runHealthCheck() {
    const checker = new AIHealthChecker({ timeout: 10000 });
    const result  = await checker.checkAll();
    const output  = {
        codex: {
            available: result.availableAIs.includes('codex'),
            error:     result.aiStatus?.codex?.error   || null,
            version:   result.aiStatus?.codex?.version || null
        },
        gemini: {
            available: result.availableAIs.includes('gemini'),
            error:     result.aiStatus?.gemini?.error   || null,
            version:   result.aiStatus?.gemini?.version || null
        },
        summary: `Available: ${result.availableAIs.join(', ') || 'none'}`
    };
    console.log(JSON.stringify(output, null, 2));
}

// ========================
// MODE 2: SINGLE TURN
// ========================
async function runSingleTurn(config) {
    config.taskType = config.taskType || detectTaskType(config.task);
    const extractedPaths = extractPathsFromTask(config.task);
    const allIncludeDirs = [...new Set([...(config.includeDirs || []), ...extractedPaths])];
    config.includeDirs = allIncludeDirs.filter(d => {
        try { return fs.realpathSync(d) !== fs.realpathSync(config.workspace); }
        catch (_e) { return true; }
    });

    console.error(`[single-turn] turn=${config.turn} task=${config.task}`);
    console.error(`[single-turn] taskType=${config.taskType}`);
    console.error(`[single-turn] workspace=${config.workspace}`);
    if (config.includeDirs.length > 0) {
        console.error(`[single-turn] includeDirs=${config.includeDirs.join(', ')}`);
    }

    // Log workspace contents for verification
    try {
        const resolvedWs = fs.realpathSync(path.resolve(config.workspace));
        if (resolvedWs !== config.workspace) console.error(`[single-turn] workspace-resolved=${resolvedWs}`);
        const wsEntries = fs.readdirSync(config.workspace).slice(0, 10);
        console.error(`[single-turn] workspace-contents=${wsEntries.join(', ')}`);
    } catch (err) {
        console.error(`[single-turn] workspace-verify-failed=${err.message}`);
    }

    // Clear Gemini session cache to prevent wrong project analysis
    try {
        const os = require('os');
        const geminiProjectsFile = path.join(os.homedir(), '.gemini', 'projects.json');
        if (fs.existsSync(geminiProjectsFile)) {
            const projects = JSON.parse(fs.readFileSync(geminiProjectsFile, 'utf8'));
            const projectSlug = projects.projects && projects.projects[config.workspace];
            if (projectSlug) {
                const chatDir = path.join(os.homedir(), '.gemini', 'tmp', projectSlug, 'chats');
                if (fs.existsSync(chatDir)) {
                    fs.rmSync(chatDir, { recursive: true, force: true });
                    console.error(`[single-turn] gemini-cache-cleared: ${chatDir}`);
                }
            }
        }
    } catch (err) {
        console.error(`[single-turn] gemini-cache-clear-failed: ${err.message}`);
    }

    // Shorter timeout for brainstorm/research
    const geminiTimeout = (config.taskType === 'brainstorm' || config.taskType === 'research')
        ? 300000   // 5 min
        : 900000;  // 15 min

    // 1. Health check
    const checker = new AIHealthChecker({ timeout: 10000 });
    const health  = await checker.checkAll();

    // 2. Determine active workers
    const workers = {};
    if (config.enableCodex && health.availableAIs.includes('codex')) {
        workers.codex = new CodexWrapper({
            workspaceDir:    config.workspace,
            includeDirs:     config.includeDirs,
            timeout:         1800000,
            enhancementMode: 'normal'
        });
        console.error(`[single-turn] codex=available`);
    } else {
        console.error(`[single-turn] codex=unavailable`);
    }

    if (config.enableGemini && health.availableAIs.includes('gemini')) {
        const geminiMode = (config.taskType === 'brainstorm' || config.taskType === 'research')
            ? 'normal'
            : 'deep-research';

        workers.gemini = new GeminiWrapper({
            workspaceDir:    config.workspace,
            includeDirs:     config.includeDirs,
            timeout:         geminiTimeout,
            enhancementMode: geminiMode,
            deepSearch:      config.taskType === 'audit',
            deepThinking:    true
        });
        console.error(`[single-turn] gemini=available (mode=${geminiMode}, timeout=${geminiTimeout / 1000}s)`);
    } else {
        console.error(`[single-turn] gemini=unavailable`);
    }

    if (Object.keys(workers).length === 0) {
        console.error(`[single-turn] ERROR: No workers available`);
        const emptyResult = { turn: config.turn, workers: {}, error: 'No workers available' };
        const outputPath  = `/tmp/claude-codex-workers-turn-${config.turn}.json`;
        fs.writeFileSync(outputPath, JSON.stringify(emptyResult, null, 2));
        console.log(JSON.stringify(emptyResult));
        return 1;
    }

    // 3. Load previous reports (for turn 2+)
    let prevReports = {};
    if (config.prevReportsFile) {
        try {
            prevReports = JSON.parse(fs.readFileSync(config.prevReportsFile, 'utf8'));
            console.error(`[single-turn] prev-reports loaded: ${Object.keys(prevReports).join(', ')}`);
        } catch (err) {
            console.error(`[single-turn] prev-reports load failed: ${err.message}`);
        }
    }

    // 4. Run workers in parallel (with retry on failure/off-topic)
    const MAX_RETRIES = 2;
    const results  = {};
    const promises = [];

    for (const [name, wrapper] of Object.entries(workers)) {
        console.error(`[single-turn] ${name} starting...`);

        promises.push(
            (async () => {
                let lastError = null;
                let lastReport = null;

                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    const startTime = Date.now();
                    const isRetry = attempt > 1;

                    if (isRetry) {
                        console.error(`[single-turn] ${name} RETRY ${attempt}/${MAX_RETRIES}...`);
                    }

                    // On retry: prepend a focus reminder to the prompt
                    let prompt = config.turn === 1
                        ? buildFirstTurnPrompt(name, config)
                        : buildCritiqueTurnPrompt(name, config, prevReports);

                    if (isRetry) {
                        const retryPrefix = `IMPORTANT: Your previous attempt was ${lastError ? 'an error/timeout' : 'off-topic or too short'}. ` +
                            `This is retry ${attempt}/${MAX_RETRIES}. Be CONCISE and FOCUSED. ` +
                            `You MUST include the JSON findings block at the end.\n\n`;
                        prompt = retryPrefix + prompt;
                    }

                    try {
                        const result   = await wrapper.execute(prompt);
                        const duration = Date.now() - startTime;
                        const report   = typeof (result.response || result) === 'string'
                            ? (result.response || result)
                            : JSON.stringify(result.response || result);

                        // Validate output quality
                        const validation = _validateWorkerOutput(report, name);

                        if (!validation.valid) {
                            console.error(`[single-turn] ${name} output invalid: ${validation.reason} (attempt ${attempt}/${MAX_RETRIES})`);
                            lastReport = report;
                            lastError = null;
                            if (attempt === MAX_RETRIES) {
                                results[name] = { name, report, duration, failed: false, attempts: attempt, warning: `Output quality low: ${validation.reason}` };
                                console.error(`[single-turn] ${name} accepted with warning after ${attempt} attempts`);
                            }
                            continue;
                        }

                        // Workspace relevance check — is the report about the right project?
                        const wsRelevance = _validateWorkspaceRelevance(report, config.workspace);
                        if (!wsRelevance.relevant) {
                            console.error(`[single-turn] ${name} WRONG PROJECT: ${wsRelevance.reason} (attempt ${attempt}/${MAX_RETRIES})`);
                            lastReport = report;
                            lastError = null;
                            if (attempt === MAX_RETRIES) {
                                results[name] = { name, report, duration, failed: false, attempts: attempt, warning: `Wrong project: ${wsRelevance.reason}` };
                                console.error(`[single-turn] ${name} accepted with wrong-project warning after ${attempt} attempts`);
                            }
                            continue;
                        }
                        console.error(`[single-turn] ${name} workspace-relevance: ${wsRelevance.reason}`);

                        // Task relevance check (soft — log only, don't retry)
                        const taskRelevance = _validateTaskRelevance(report, config.task);
                        if (!taskRelevance.relevant) {
                            console.error(`[single-turn] ${name} TASK-DRIFT WARNING: ${taskRelevance.reason}`);
                        } else {
                            console.error(`[single-turn] ${name} task-relevance: ${taskRelevance.reason}`);
                        }

                        results[name] = {
                            name, report, duration, failed: false, attempts: attempt,
                            ...(taskRelevance.relevant ? {} : { warning: `Task drift: ${taskRelevance.reason}` })
                        };
                        console.error(`[single-turn] ${name} completed (${Math.round(duration / 1000)}s, attempt ${attempt})`);
                        return; // Success — exit retry loop

                    } catch (error) {
                        const duration = Date.now() - startTime;
                        lastError = error;
                        console.error(`[single-turn] ${name} attempt ${attempt} FAILED: ${error.message}`);

                        if (attempt === MAX_RETRIES) {
                            results[name] = {
                                name,
                                report:   `[${name.toUpperCase()} ERROR after ${attempt} attempts: ${error.message.substring(0, 300)}]`,
                                duration,
                                failed:   true,
                                attempts: attempt
                            };
                            console.error(`[single-turn] ${name} FAILED after ${attempt} attempts`);
                        }
                    }
                }
            })()
        );
    }

    await Promise.allSettled(promises);

    // 5. Save results
    const output = {
        turn:      config.turn,
        workers:   results,
        timestamp: new Date().toISOString()
    };

    const outputPath = `/tmp/claude-codex-workers-turn-${config.turn}.json`;
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.error(`[single-turn] results saved: ${outputPath}`);
    console.log(JSON.stringify({ turn: config.turn, output: outputPath, workers: Object.keys(results) }));

    return 0;
}

// ========================
// MODE 3: CONVERGENCE CHECK
// ========================
async function checkConvergence(reportsFile) {
    try {
        const allReports = JSON.parse(fs.readFileSync(reportsFile, 'utf8'));
        const entries    = Object.entries(allReports).filter(([_, data]) => data && data.report && !data.failed);

        if (entries.length < 2) {
            console.log(JSON.stringify({
                score: 0, converged: false,
                details: `Only ${entries.length} valid report(s). Need at least 2 for convergence.`,
                agreed: [], disagreed: [], providers: entries.map(([name]) => name)
            }));
            return;
        }

        const reportTexts   = entries.map(([_, data]) => data.report);
        const providerNames = entries.map(([name]) => name);

        const result    = convergence.measureConvergence(reportTexts, providerNames);
        const converged = convergence.hasConverged(result.score, 0.90);

        console.log(JSON.stringify({
            score:      result.score,
            converged,
            details:    result.details,
            agreed:     result.agreed     || [],
            disagreed:  result.disagreed  || [],
            providers:  providerNames
        }));
    } catch (err) {
        console.error(`[convergence] ERROR: ${err.message}`);
        console.log(JSON.stringify({ score: 0, converged: false, error: err.message }));
    }
}

// ========================
// MAIN
// ========================
async function main() {
    const config = parseArgs(process.argv);

    // Mode 1: Health check
    if (config.healthOnly) {
        await runHealthCheck();
        return;
    }

    // Mode 3: Convergence check
    if (config.checkConvergenceFile) {
        await checkConvergence(config.checkConvergenceFile);
        return;
    }

    // Workspace validation (for single-turn)
    if (config.singleTurn || config.task) {
        config.workspace = validateWorkspace(config.workspace);
    }

    // Mode 2: Single turn
    if (config.singleTurn) {
        if (!config.task) {
            console.error('--single-turn requires --task');
            process.exit(1);
        }
        const exitCode = await runSingleTurn(config);
        process.exit(exitCode);
    }

    // No mode selected — show usage
    console.error('Usage:');
    console.error('  node run-orchestration.js --health-check');
    console.error('  node run-orchestration.js --single-turn --turn N --task "task" --workspace "/path" [--prev-reports file.json]');
    console.error('  node run-orchestration.js --check-convergence /path/to/reports.json');
    console.error('');
    console.error('Modes:');
    console.error('  --health-check          Check AI worker availability');
    console.error('  --single-turn           Run a single turn (for Claude active participation)');
    console.error('  --check-convergence F   Measure convergence from JSON reports file');
    process.exit(1);
}

main().catch(err => {
    console.error(`[orchestration] FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
