'use strict';

/**
 * Gemini CLI Wrapper (merged: GeminiCLIWrapper + EnhancedGeminiWrapper)
 *
 * Zero external dependencies.  Spawns `gemini --yolo` with stdin.
 * Enhancement modes: normal, deep-research, deep-analysis.
 */

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const logger    = require('./logger');

const DEFAULT_TIMEOUT = 1800000; // 30 minutes

class GeminiWrapper {
    /**
     * @param {object} opts
     * @param {number}   [opts.timeout]
     * @param {string}   [opts.workspaceDir]
     * @param {boolean}  [opts.debug]
     * @param {boolean}  [opts.deepSearch]
     * @param {boolean}  [opts.deepThinking]
     * @param {string}   [opts.model]
     * @param {string[]} [opts.includeDirs]
     * @param {string}   [opts.enhancementMode]  normal | deep-research | deep-analysis
     */
    constructor(opts = {}) {
        this.options = {
            timeout:         opts.timeout         || DEFAULT_TIMEOUT,
            workspaceDir:    opts.workspaceDir    || process.cwd(),
            debug:           opts.debug           || false,
            deepSearch:      opts.deepSearch      || false,
            deepThinking:    opts.deepThinking    || false,
            model:           opts.model           || null,
            includeDirs:     opts.includeDirs     || [],
            enhancementMode: opts.enhancementMode || 'normal',
            ...opts
        };
    }

    /* ------------------------------------------------------------------ */
    /*  Public API                                                         */
    /* ------------------------------------------------------------------ */

    async checkAuth() {
        try {
            await new Promise((resolve, reject) => {
                const proc = spawn('gemini', ['--version'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
                let output = '';
                proc.stdout.on('data', (d) => { output += d; });
                proc.stderr.on('data', (d) => { output += d; });
                proc.on('exit', (code) => {
                    (code === 0 || output.includes('0.')) ? resolve(true) : reject(new Error('Gemini not found'));
                });
                setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, 5000);
            });
            return { authenticated: true, message: 'Gemini CLI available' };
        } catch (error) {
            return { authenticated: false, message: error.message };
        }
    }

    /**
     * Execute a prompt through Gemini CLI.
     * Applies enhancement mode automatically.
     */
    async execute(prompt, options = {}) {
        const mode = options.enhancementMode || this.options.enhancementMode;
        let enhancedPrompt = prompt;
        let deepOptions = {};

        switch (mode) {
            case 'deep-research':
                enhancedPrompt = this._applyDeepResearchProtocol(prompt);
                deepOptions = { deepThinking: true };
                logger.info('Gemini Deep Research mode active');
                break;
            case 'deep-analysis':
                enhancedPrompt = this._applyDeepAnalysisProtocol(prompt);
                deepOptions = { deepThinking: true };
                logger.info('Gemini Deep Analysis mode active');
                break;
            default:
                logger.info('Gemini Normal mode active');
                break;
        }

        return this._executeRaw(enhancedPrompt, { ...options, ...deepOptions });
    }

    /* ------------------------------------------------------------------ */
    /*  Core execution                                                     */
    /* ------------------------------------------------------------------ */

    /** @private */
    async _executeRaw(prompt, options = {}) {
        const startTime = Date.now();
        const execOptions = {
            deepSearch:   options.deepSearch   ?? this.options.deepSearch,
            deepThinking: options.deepThinking ?? this.options.deepThinking,
            model:        options.model        || this.options.model,
            includeDirs:  options.includeDirs  || this.options.includeDirs
        };

        const targetCwd = options.workDir || this.options.workspaceDir;
        this._validateCwd(targetCwd);

        if (this.options.debug) {
            logger.info('Gemini CLI executing...');
            logger.info(`  Deep Thinking: ${execOptions.deepThinking}`);
            logger.info(`  Model: ${execOptions.model || 'default'}`);
        }

        logger.info(`Gemini CWD: ${targetCwd}`);

        return new Promise((resolve, reject) => {
            const args = this._buildArgs(execOptions);

            if (this.options.debug) {
                logger.info(`Prompt size: ${prompt.length} chars`);
                logger.info(`Gemini args: ${args.join(' ') || '(none)'}`);
            }

            const childProcess = spawn('gemini', args, {
                cwd:   targetCwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            });

            // Workspace enforcer: prompt'un başına CWD bilgisi ekle
            // Gemini'nin eski oturumlardan context yükleyip yanlış projeyi analiz etmesini engeller
            const workspaceEnforcement = `[SYSTEM CONTEXT] Your current working directory is: ${targetCwd}\nYou MUST ONLY analyze files in this directory. Ignore any previous session context.\n\n`;
            const enforcedPrompt = workspaceEnforcement + (prompt || '');

            if (enforcedPrompt) {
                childProcess.stdin.write(enforcedPrompt);
                childProcess.stdin.end();
            }

            let stdout   = '';
            let stderr   = '';
            let timedOut = false;

            childProcess.stdout.on('data', (d) => { stdout += d.toString(); });
            childProcess.stderr.on('data', (d) => { stderr += d.toString(); });

            childProcess.on('exit', (code) => {
                clearTimeout(timeoutHandle);
                const duration = Date.now() - startTime;

                if (this.options.debug) {
                    logger.info(`Gemini completed (${duration}ms, exit: ${code})`);
                }

                // Graceful timeout with partial results
                if (timedOut && stdout.length > 100) {
                    logger.warn('Gemini timeout - using partial results');
                    resolve({
                        success: true,
                        response: stdout.trim() + '\n\n[TIMEOUT: Partial results]',
                        duration,
                        partial: true
                    });
                    return;
                }

                if (stdout && stdout.length > 10) {
                    resolve({ success: true, response: this._cleanOutput(stdout), duration });
                } else if (code !== 0) {
                    reject(new Error(`Gemini failed (exit ${code}): ${stderr || 'No output'}`));
                } else {
                    resolve({ success: true, response: stdout.trim() || 'No response', duration });
                }
            });

            childProcess.on('error', (error) => {
                clearTimeout(timeoutHandle);
                reject(new Error(`Gemini spawn error: ${error.message}`));
            });

            const timeoutHandle = setTimeout(() => {
                timedOut = true;
                logger.warn(`Gemini timeout (${(options.timeout || this.options.timeout) / 1000}s) - graceful shutdown...`);
                childProcess.kill('SIGTERM');
            }, options.timeout || this.options.timeout);
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */

    /** @private — Remove login messages, URLs, etc. from raw output */
    _cleanOutput(rawOutput) {
        const lines = rawOutput.split('\n');
        const cleaned = [];
        let skip = false;

        for (const line of lines) {
            const t = line.trim();
            if (t.includes('Code Assist login') || t.includes('authentication page') ||
                t.includes('navigate to:') || t.includes('Waiting for authentication')) { skip = true; continue; }
            if (t.startsWith('http://') || t.startsWith('https://')) continue;
            if (skip && t === '') continue;
            if (skip && t !== '') skip = false;
            if (!skip) cleaned.push(line);
        }
        return cleaned.join('\n').trim();
    }

    /** @private — Validate that cwd exists and is a directory */
    _validateCwd(cwd) {
        if (!cwd) throw new Error('Gemini CWD is empty or undefined.');

        let resolved;
        try { resolved = fs.realpathSync(path.resolve(cwd)); }
        catch (err) { throw new Error(`Gemini CWD not found: "${cwd}" - ${err.message}`); }

        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) throw new Error(`Gemini CWD is not a directory: "${resolved}"`);

        if (cwd !== resolved) logger.info(`Gemini CWD resolved: "${cwd}" -> "${resolved}"`);
    }

    /** @private — Build CLI arguments */
    _buildArgs(options) {
        const args = ['--yolo'];

        if (options.model) {
            args.push('-m', options.model);
            logger.info(`Gemini model: ${options.model}`);
        }

        const dirs = options.includeDirs || [];
        for (const dir of dirs) {
            args.push('--include-directories', dir);
        }
        if (dirs.length > 0) logger.info(`Gemini include-directories: ${dirs.join(', ')}`);

        return args;
    }

    /* ------------------------------------------------------------------ */
    /*  Enhancement protocols (inline — no external files)                */
    /* ------------------------------------------------------------------ */

    /** @private */
    _applyDeepResearchProtocol(prompt) {
        return `# DEEP RESEARCH MODE (Gemini + Deep Search + Deep Thinking)

You are an expert researcher and analyst. Use ALL your capabilities for this task.

## RESEARCH PROTOCOL

### Phase 1: Deep Web Research
- Search for relevant sources, documentation, and best practices
- Check current security vulnerabilities and CVEs
- Research Stack Overflow, GitHub Issues, security blogs
- Cite each finding with its source URL
- Check npm/pip package security status

### Phase 2: Code Analysis
- Examine given files line by line
- Identify patterns and anti-patterns
- Analyze dependencies and security risks
- Support each finding with file:line references
- Evaluate code quality and maintainability

### Phase 3: Deep Thinking
- Synthesize all findings
- Apply critical thinking - find root causes, not just surface issues
- Explain the rationale for each recommendation
- Evaluate trade-offs and alternative solutions
- Apply "5 Whys" technique

### Phase 4: Evidence-Based Reporting
- Provide file:line reference for each finding
- Specify severity level (CRITICAL, HIGH, MEDIUM, LOW)
- Offer concrete fix suggestions
- Estimate effort and impact

## CRITICAL RULES
- NEVER do shallow analysis
- NEVER report findings without evidence
- Support every claim with a file reference
- Use Deep Thinking mode actively
- You will be compared with other AIs for consensus - be thorough!

---

## TASK

${prompt}

---

**IMPORTANT:** This analysis will be used for 3-AI consensus. Your findings will be compared with Claude and Codex. Produce the highest quality, most detailed, most evidence-based analysis!`;
    }

    /** @private */
    _applyDeepAnalysisProtocol(prompt) {
        return `# DEEP ANALYSIS MODE

You are an expert code analyst and security researcher.

## ANALYSIS PROTOCOL

### Critical Thinking Framework
1. **Deep Analysis, Not First Impressions**
   - Find root causes, not surface issues
   - Ask "Why" five times (5 Whys)

2. **Multiple Perspectives**
   - Security, Performance, Maintainability, Scalability

3. **Evidence-Based**
   - Support every claim with code references
   - Do not assume - verify

### Output Quality
- Be specific: not "there is an issue" but "lib/x.js:45 has buffer overflow risk"
- Assign severity to every finding
- Be actionable: what to do, how to do it

---

## ANALYSIS TASK

${prompt}

---

**WARNING:** This analysis will be used for consensus. You will be compared with other AIs. Produce high-quality, evidence-based analysis.`;
    }
}

module.exports = GeminiWrapper;
