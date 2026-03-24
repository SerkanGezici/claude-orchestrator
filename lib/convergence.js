'use strict';

const SEMANTIC_WEIGHT = 0.4;
const EVIDENCE_WEIGHT = 0.6;
const JACCARD_MATCH_THRESHOLD = 0.5;

/** Try to parse JSON from a report (may be wrapped in ```json blocks or plain). */
function _parseJsonReport(report) {
    if (!report) return null;
    // Try extracting from ```json ... ``` block
    const jsonBlock = report.match(/```json\s*([\s\S]*?)```/);
    const candidate = jsonBlock ? jsonBlock[1].trim() : report.trim();
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && Array.isArray(parsed.findings)) return parsed;
    } catch { /* not JSON, fall through */ }
    return null;
}

/** Extract structured findings from JSON report. */
function _extractFindingsFromJson(parsed) {
    return parsed.findings
        .filter(f => f.title && f.severity)
        .map(f => ({
            title: f.title.toLowerCase().trim(),
            severity: f.severity.toLowerCase().trim(),
            hasEvidence: !!(f.evidence && f.evidence.length > 5),
            id: f.id || null
        }));
}

function _extractFindings(report) {
    if (!report) return [];
    // Try JSON first
    const json = _parseJsonReport(report);
    if (json) {
        return _extractFindingsFromJson(json).map(f => `${f.title} [${f.severity}]`);
    }
    // Fallback: text-based extraction
    return report.split('\n')
        .map(line => line.trim())
        .filter(line => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
        .map(line => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').toLowerCase().trim())
        .filter(f => f.length > 0);
}

function _jaccardSimilarity(str1, str2) {
    const words1 = new Set(str1.split(/\s+/).filter(w => w.length > 0));
    const words2 = new Set(str2.split(/\s+/).filter(w => w.length > 0));
    if (words1.size === 0 && words2.size === 0) return 0;
    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;
    return union === 0 ? 0 : intersection / union;
}

function _hasEvidence(finding) {
    const filePathPattern = /[a-zA-Z0-9_/.-]+\.[a-zA-Z]{1,5}/;
    const lineNumberPattern = /line\s*[:\s]\s*\d+/i;
    return filePathPattern.test(finding) || lineNumberPattern.test(finding);
}

/** JSON-based convergence: compare structured findings across reports. */
function _measureJsonConvergence(parsedReports, providerNames) {
    const allFindings = parsedReports.map(p => _extractFindingsFromJson(p));
    const flatFindings = allFindings.flat();
    if (flatFindings.length === 0) return null; // fallback to text

    // Match findings by normalized title (more accurate than Jaccard on free text)
    const titleMap = new Map(); // title -> { count, severityMatch, hasEvidence[] }
    for (let i = 0; i < allFindings.length; i++) {
        for (const f of allFindings[i]) {
            const key = f.title;
            if (!titleMap.has(key)) {
                titleMap.set(key, { title: key, reporters: new Set(), severities: [], evidenced: [] });
            }
            const entry = titleMap.get(key);
            entry.reporters.add(i);
            entry.severities.push(f.severity);
            entry.evidenced.push(f.hasEvidence);
        }
    }

    // Also do fuzzy matching for similar titles
    const titles = [...titleMap.keys()];
    for (let i = 0; i < titles.length; i++) {
        for (let j = i + 1; j < titles.length; j++) {
            if (_jaccardSimilarity(titles[i], titles[j]) > JACCARD_MATCH_THRESHOLD) {
                // Merge j into i
                const entryI = titleMap.get(titles[i]);
                const entryJ = titleMap.get(titles[j]);
                for (const r of entryJ.reporters) entryI.reporters.add(r);
                entryI.severities.push(...entryJ.severities);
                entryI.evidenced.push(...entryJ.evidenced);
                titleMap.delete(titles[j]);
            }
        }
    }

    const numReports = parsedReports.length;
    const majority = Math.ceil(numReports / 2);
    const entries = [...titleMap.values()];

    const agreed = entries.filter(e => e.reporters.size >= majority).map(e => e.title);
    const disagreed = entries.filter(e => e.reporters.size === 1).map(e => e.title);

    // Semantic: shared findings ratio
    const sharedCount = numReports > 1 ? entries.filter(e => e.reporters.size >= 2).length : 0;
    const semanticSimilarity = entries.length > 0 ? sharedCount / entries.length : 0;

    // Severity agreement bonus: findings where all reporters agree on severity
    const severityAgreed = entries.filter(e => {
        const unique = new Set(e.severities);
        return unique.size === 1 && e.reporters.size >= 2;
    }).length;
    const severityBonus = entries.length > 0 ? (severityAgreed / entries.length) * 0.1 : 0;

    // Evidence quality
    const evidenceCount = flatFindings.filter(f => f.hasEvidence).length;
    const evidenceQuality = flatFindings.length > 0 ? evidenceCount / flatFindings.length : 0;

    const score = Math.min(1, semanticSimilarity * SEMANTIC_WEIGHT + evidenceQuality * EVIDENCE_WEIGHT + severityBonus);
    const details = `Providers: ${(providerNames || []).join(', ')} | Mode: JSON | ` +
        `Unique: ${entries.length} | Shared: ${sharedCount} | SevMatch: ${severityAgreed} | ` +
        `Semantic: ${semanticSimilarity.toFixed(2)} | Evidence: ${evidenceQuality.toFixed(2)} | Score: ${score.toFixed(2)}`;

    return { score, details, agreed, disagreed };
}

function measureConvergence(reports, providerNames) {
    const empty = { score: 0, details: '', agreed: [], disagreed: [] };
    if (!reports || reports.length === 0) return { ...empty, details: 'No reports provided' };

    // Try JSON-based convergence first
    const parsedReports = reports.map(r => _parseJsonReport(r));
    const allJson = parsedReports.every(p => p !== null);
    if (allJson && parsedReports.length >= 2) {
        const jsonResult = _measureJsonConvergence(parsedReports, providerNames);
        if (jsonResult) return jsonResult;
    }

    // Fallback: text-based convergence
    const allFindings = reports.map(r => _extractFindings(r));
    const flatFindings = allFindings.flat();
    if (flatFindings.length === 0) return { ...empty, details: 'No findings extracted' };
    // Deduplicate unique findings using Jaccard matching
    const unique = [];
    for (const f of flatFindings) {
        if (!unique.some(u => _jaccardSimilarity(u, f) > JACCARD_MATCH_THRESHOLD)) unique.push(f);
    }
    // Count how many reports each unique finding appears in
    const reportCount = unique.map(u => {
        let count = 0;
        for (const rf of allFindings) {
            if (rf.some(f => _jaccardSimilarity(f, u) > JACCARD_MATCH_THRESHOLD)) count++;
        }
        return { finding: u, count };
    });
    const majority = Math.ceil(reports.length / 2);
    const agreed = reportCount.filter(r => r.count >= majority).map(r => r.finding);
    const disagreed = reportCount.filter(r => r.count === 1).map(r => r.finding);
    // Semantic similarity: findings in 2+ reports / total unique
    const sharedCount = reports.length > 1 ? reportCount.filter(r => r.count >= 2).length : 0;
    const semanticSimilarity = unique.length > 0 ? sharedCount / unique.length : 0;
    // Evidence quality: findings with file paths or line numbers / total
    const evidenceCount = flatFindings.filter(f => _hasEvidence(f)).length;
    const evidenceQuality = flatFindings.length > 0 ? evidenceCount / flatFindings.length : 0;
    const score = Math.min(1, semanticSimilarity * SEMANTIC_WEIGHT + evidenceQuality * EVIDENCE_WEIGHT);
    const details = `Providers: ${(providerNames || []).join(', ')} | Mode: text | ` +
        `Unique: ${unique.length} | Shared: ${sharedCount} | ` +
        `Semantic: ${semanticSimilarity.toFixed(2)} | Evidence: ${evidenceQuality.toFixed(2)} | Score: ${score.toFixed(2)}`;
    return { score, details, agreed, disagreed };
}

function hasConverged(score, threshold) {
    return score >= threshold;
}

module.exports = {
    measureConvergence,
    hasConverged,
    _extractFindings,
    _extractFindingsFromJson,
    _parseJsonReport,
    _jaccardSimilarity,
    _hasEvidence
};
