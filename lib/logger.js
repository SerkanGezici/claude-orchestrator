'use strict';

/**
 * Simple console-based logger (zero dependencies)
 *
 * All output goes to stderr so it does not interfere with
 * stdout JSON that Claude Code reads.
 */

const logger = {
    info(msg)  { console.error(`[INFO] ${msg}`); },
    warn(msg)  { console.error(`[WARN] ${msg}`); },
    error(msg) { console.error(`[ERROR] ${msg}`); },
    debug(msg, ...args) {
        if (process.env.DEBUG) {
            console.error(`[DEBUG] ${msg}`, ...args);
        }
    }
};

module.exports = logger;
