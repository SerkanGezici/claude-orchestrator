'use strict';

/**
 * AI Health Checker (zero dependencies)
 *
 * Checks availability of Claude, Codex, and Gemini CLIs in parallel.
 */

const { spawn } = require('child_process');
const logger = require('./logger');

class AIHealthChecker {
    constructor(options = {}) {
        this.options = {
            timeout: options.timeout || 10000,
            verbose: options.verbose || false,
            ...options
        };

        this.aiStatus = {
            claude: { available: false, error: null, version: null },
            codex:  { available: false, error: null, version: null },
            gemini: { available: false, error: null, version: null }
        };

        this.checkCompleted = false;
    }

    /**
     * Check all AIs in parallel.
     * @returns {{ availableAIs: string[], unavailableAIs: object[], allAvailable: boolean, noneAvailable: boolean, checkDuration: number, status: object }}
     */
    async checkAll() {
        if (this.options.verbose) {
            logger.info('AI availability check starting...');
        }

        const startTime = Date.now();

        const [claudeResult, codexResult, geminiResult] = await Promise.all([
            this._pingClaude(),
            this._pingCodex(),
            this._pingGemini()
        ]);

        this.aiStatus.claude = claudeResult;
        this.aiStatus.codex  = codexResult;
        this.aiStatus.gemini = geminiResult;
        this.checkCompleted  = true;

        const duration = Date.now() - startTime;

        const availableAIs   = [];
        const unavailableAIs = [];

        for (const [name, result] of Object.entries(this.aiStatus)) {
            if (result.available) {
                availableAIs.push(name);
            } else {
                unavailableAIs.push({ name, error: result.error });
            }
        }

        const result = {
            availableAIs,
            unavailableAIs,
            allAvailable:  unavailableAIs.length === 0,
            noneAvailable: availableAIs.length === 0,
            checkDuration: duration,
            status:        this.aiStatus
        };

        if (this.options.verbose) {
            logger.info(`Check completed (${duration}ms)`);
            logger.info(`  Available: ${availableAIs.join(', ') || 'None'}`);
            if (unavailableAIs.length > 0) {
                logger.warn(`  Unavailable: ${unavailableAIs.map(a => a.name).join(', ')}`);
            }
        }

        return result;
    }

    /** @private */
    async _pingClaude() {
        return this._pingBinary('claude', ['--version'], (stdout, stderr, code) => {
            return code === 0 || stdout.length > 0 || stderr.includes('claude');
        });
    }

    /** @private — deep check: sends a short prompt to verify API access */
    async _pingCodex() {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ available: false, error: 'Timeout', version: null });
            }, this.options.timeout);

            try {
                const proc = spawn('codex', ['exec', '--sandbox', 'read-only', '-'], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: false,
                    timeout: this.options.timeout
                });

                let stdout = '';
                let stderr = '';

                proc.stdin.write('Reply with only: OK');
                proc.stdin.end();

                proc.stdout.on('data', (d) => { stdout += d.toString(); });
                proc.stderr.on('data', (d) => { stderr += d.toString(); });

                proc.on('close', (code) => {
                    clearTimeout(timeout);

                    // Subscription / auth errors
                    if (stderr.includes('upgrade to Plus') ||
                        stderr.includes('subscription') ||
                        stderr.includes('API key') ||
                        stderr.includes('authentication') ||
                        stderr.includes('unauthorized')) {
                        let errorMsg = 'Subscription or auth error';
                        if (stderr.includes('upgrade to Plus')) errorMsg = 'ChatGPT Plus subscription required';
                        else if (stderr.includes('API key'))    errorMsg = 'API key missing/invalid';
                        else if (stderr.includes('authentication')) errorMsg = 'Authentication failed';

                        resolve({ available: false, error: errorMsg, version: this._extractVersion(stderr, 'codex') });
                        return;
                    }

                    if (code === 0 || stdout.length > 0) {
                        resolve({ available: true, error: null, version: this._extractVersion(stderr || stdout, 'codex') });
                    } else {
                        resolve({ available: false, error: `Exit code: ${code}. ${stderr || 'Unknown error'}`, version: null });
                    }
                });

                proc.on('error', (err) => {
                    clearTimeout(timeout);
                    resolve({
                        available: false,
                        error: err.code === 'ENOENT' ? 'Codex CLI not installed' : `Spawn error: ${err.message}`,
                        version: null
                    });
                });
            } catch (error) {
                clearTimeout(timeout);
                resolve({ available: false, error: `Exception: ${error.message}`, version: null });
            }
        });
    }

    /** @private */
    async _pingGemini() {
        return this._pingBinary('gemini', ['--version'], (stdout, stderr, code) => {
            return code === 0 || stdout.includes('0.') || stderr.includes('0.');
        }, { shell: true });
    }

    /**
     * Generic binary ping helper.
     * @private
     */
    async _pingBinary(name, args, successCheck, spawnOpts = {}) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ available: false, error: 'Timeout', version: null });
            }, this.options.timeout);

            try {
                const proc = spawn(name, args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: false,
                    timeout: this.options.timeout,
                    ...spawnOpts
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (d) => { stdout += d.toString(); });
                proc.stderr.on('data', (d) => { stderr += d.toString(); });

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    if (successCheck(stdout, stderr, code)) {
                        resolve({ available: true, error: null, version: this._extractVersion(stdout || stderr, name) });
                    } else {
                        resolve({ available: false, error: `Exit code: ${code}. ${stderr || 'Unknown error'}`, version: null });
                    }
                });

                proc.on('error', (err) => {
                    clearTimeout(timeout);
                    resolve({
                        available: false,
                        error: err.code === 'ENOENT' ? `${name} CLI not installed` : `Spawn error: ${err.message}`,
                        version: null
                    });
                });
            } catch (error) {
                clearTimeout(timeout);
                resolve({ available: false, error: `Exception: ${error.message}`, version: null });
            }
        });
    }

    /** @private */
    _extractVersion(text, _aiName) {
        if (!text) return 'unknown';
        const patterns = [
            /(\d+\.\d+\.\d+)/,
            /(\d+\.\d+)/,
            /version\s*[:\s]*(\S+)/i,
            /v(\d+\.\d+\.\d+)/,
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) return match[1];
        }
        return 'detected';
    }

    /** Format a human-readable warning message. */
    formatWarningMessage(checkResult) {
        if (checkResult.allAvailable) return null;

        if (checkResult.noneAvailable) {
            const lines = checkResult.unavailableAIs.map(ai => `  - ${ai.name.toUpperCase()}: ${ai.error || 'Unknown error'}`);
            return `CRITICAL: No AI workers available!\n${lines.join('\n')}\n\nInstall at least one:\n  Claude: npm install -g @anthropic-ai/claude-code\n  Codex:  npm install -g @openai/codex\n  Gemini: pip install google-generativeai`;
        }

        const available   = checkResult.availableAIs.map(n => n.toUpperCase()).join(', ');
        const unavailable = checkResult.unavailableAIs.map(ai => `  - ${ai.name.toUpperCase()}: ${ai.error || 'Unreachable'}`);
        return `WARNING: Some AIs unavailable\n  Available: ${available}\n  Unavailable:\n${unavailable.join('\n')}`;
    }

    getStatus(aiName)       { return this.aiStatus[aiName] || null; }
    getAllStatus()           { return this.aiStatus; }

    getOrchestrationConfig(checkResult) {
        return {
            enableClaude: checkResult.availableAIs.includes('claude'),
            enableCodex:  checkResult.availableAIs.includes('codex'),
            enableGemini: checkResult.availableAIs.includes('gemini'),
            availableCount: checkResult.availableAIs.length,
            mode: checkResult.availableAIs.length === 3 ? 'full'
                : checkResult.availableAIs.length === 2 ? 'dual'
                : checkResult.availableAIs.length === 1 ? 'single'
                : 'none'
        };
    }
}

module.exports = AIHealthChecker;
