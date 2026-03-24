'use strict';

/**
 * Codex CLI Wrapper (merged: codex-interactive-wrapper + CodexCLIWrapper + EnhancedCodexWrapper)
 *
 * Zero external dependencies. Spawns `codex exec` with stdin mode only.
 * Enhancement modes: normal, security-focus, performance-focus.
 */

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const logger    = require('./logger');

const DEFAULT_TIMEOUT = 1800000; // 30 minutes

class CodexWrapper {
    /**
     * @param {object} opts
     * @param {number}   [opts.timeout]
     * @param {string}   [opts.workspaceDir]
     * @param {boolean}  [opts.debug]
     * @param {string[]} [opts.includeDirs]
     * @param {string}   [opts.enhancementMode]  normal | security-focus | performance-focus
     */
    constructor(opts = {}) {
        this.options = {
            timeout:         opts.timeout         || DEFAULT_TIMEOUT,
            workspaceDir:    opts.workspaceDir    || process.cwd(),
            debug:           opts.debug           || false,
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
                const proc = spawn('codex', ['--version'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
                let output = '';
                proc.stdout.on('data', (d) => { output += d; });
                proc.stderr.on('data', (d) => { output += d; });
                proc.on('exit', (code) => {
                    (code === 0 || output.includes('Codex CLI')) ? resolve(true) : reject(new Error('Codex not found'));
                });
                setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, 5000);
            });
            return { authenticated: true, message: 'Codex exec available' };
        } catch (error) {
            return { authenticated: false, message: error.message };
        }
    }

    /**
     * Execute a prompt through Codex CLI (stdin mode).
     * Applies enhancement mode automatically.
     */
    async execute(prompt, options = {}) {
        const mode = options.enhancementMode || this.options.enhancementMode;
        let enhancedPrompt = prompt;

        switch (mode) {
            case 'security-focus':
                enhancedPrompt = this._applySecurityFocus(prompt);
                logger.info('Codex Security Focus mode active');
                break;
            case 'performance-focus':
                enhancedPrompt = this._applyPerformanceFocus(prompt);
                logger.info('Codex Performance Focus mode active');
                break;
            default:
                logger.info('Codex Normal mode active');
                break;
        }

        return this._executeStdin(enhancedPrompt, options);
    }

    /* ------------------------------------------------------------------ */
    /*  Core execution (stdin mode only)                                   */
    /* ------------------------------------------------------------------ */

    /** @private */
    async _executeStdin(prompt, options = {}) {
        const startTime = Date.now();

        // Adaptive timeout based on prompt length
        const adaptiveTimeout = this._calculateAdaptiveTimeout(prompt);
        const timeoutMs = options.timeout || this.options.timeout || adaptiveTimeout;

        const includeDirs  = options.includeDirs || this.options.includeDirs || [];
        const sandboxMode  = includeDirs.length > 0 ? 'read-only-root' : 'workspace-write';
        const workspaceDir = options.workDir || this.options.workspaceDir;

        logger.info(`Codex starting (${sandboxMode} mode, stdin)`);
        logger.info(`Codex CWD: ${workspaceDir}`);
        logger.info(`Adaptive timeout: ${Math.round(timeoutMs / 60000)} min (${prompt.length} chars)`);
        if (includeDirs.length > 0) logger.info(`Codex include-dirs: ${includeDirs.join(', ')}`);

        if (this.options.debug) {
            logger.info('Codex exec (stdin mode) executing...');
        }

        return new Promise((resolve, reject) => {
            const codexArgs = ['exec', '--sandbox', sandboxMode, '--skip-git-repo-check'];

            for (const dir of includeDirs) {
                codexArgs.push('--read-dirs', dir);
            }
            codexArgs.push('-'); // read from stdin

            const codex = spawn('codex', codexArgs, {
                cwd:     workspaceDir,
                timeout: timeoutMs
            });

            let stdout   = '';
            let stderr   = '';
            let timedOut = false;

            codex.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            codex.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

            codex.on('close', (code) => {
                clearTimeout(timeoutHandle);
                const duration = Date.now() - startTime;

                if (this.options.debug) {
                    logger.info(`Codex completed (${duration}ms, exit: ${code})`);
                }

                // Graceful timeout with partial results
                if (timedOut && stdout.length > 100) {
                    logger.warn('Codex timeout - using partial results');
                    resolve({
                        success:  true,
                        response: stdout.trim() + '\n\n[TIMEOUT: Partial results]',
                        duration,
                        partial:  true
                    });
                    return;
                }

                if (code === 0 || (stdout && stdout.length > 100)) {
                    if (code !== 0) logger.warn(`Codex exit code ${code} but output present, continuing`);
                    resolve({ success: true, response: stdout.trim(), duration });
                } else if (stdout && stdout.length > 10) {
                    resolve({ success: true, response: stdout.trim(), duration });
                } else {
                    reject(new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`));
                }
            });

            codex.on('error', (error) => {
                clearTimeout(timeoutHandle);
                reject(new Error(`Codex spawn error: ${error.message}`));
            });

            // Write prompt to stdin
            codex.stdin.write(prompt, 'utf8');
            codex.stdin.end();

            // Graceful timeout
            const timeoutHandle = setTimeout(() => {
                timedOut = true;
                logger.warn(`Codex timeout (${timeoutMs / 1000}s) - graceful shutdown...`);
                codex.kill('SIGTERM');
            }, timeoutMs);
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */

    /** @private — Adaptive timeout: longer prompts get more time */
    _calculateAdaptiveTimeout(prompt) {
        const charPerSecond = 50;
        const minTimeout    = 300000;   // 5 min
        const maxTimeout    = 3600000;  // 60 min
        const estimated     = (prompt.length / charPerSecond) * 1000;
        return Math.ceil(Math.min(Math.max(estimated, minTimeout), maxTimeout));
    }

    /* ------------------------------------------------------------------ */
    /*  Enhancement protocols (inline — no external files)                */
    /* ------------------------------------------------------------------ */

    /** @private */
    _applySecurityFocus(prompt) {
        return `# SECURITY FOCUS MODE

You are a security expert. Every code suggestion must be analyzed against OWASP Top 10.

## Security Checklist
- Input Validation (whitelist, not blacklist)
- Output Encoding (context-aware escaping)
- Parameterized Queries (NO string concat)
- Strong Authentication (MFA, password policies)
- Proper Authorization (RBAC, least privilege)
- Secrets Management (env vars, vault)
- HTTPS Everywhere
- CORS Configuration
- Rate Limiting
- Security Headers (CSP, HSTS, etc.)

## Threat Modeling
- Attack vectors?
- Where is sensitive data?
- Trust boundaries?
- Attack surface analysis

---

## SECURITY ANALYSIS TASK

${prompt}

---

**Format:** Security analysis + secure implementation + threat mitigation`;
    }

    /** @private */
    _applyPerformanceFocus(prompt) {
        return `# PERFORMANCE FOCUS MODE

You are a performance engineer. Every suggestion must include O(n) analysis.

## Performance Framework

### Complexity Analysis
- Time Complexity: Big-O notation
- Space Complexity: Memory usage
- Scalability projection (10x, 100x, 1000x data)

### Optimization Strategies
- Algorithm optimization (better data structures)
- Database query optimization (indexes, query plan)
- Caching strategies (memoization, CDN, Redis)
- Lazy loading & code splitting
- Parallelization opportunities

### Performance Budgets
- Page load: <3s (mobile 4G)
- API response: <100ms (p95)
- Database query: <50ms
- Bundle size: <200KB (initial)

---

## PERFORMANCE OPTIMIZATION TASK

${prompt}

---

**Format:** Performance analysis + optimized implementation + benchmark comparison`;
    }
}

module.exports = CodexWrapper;
