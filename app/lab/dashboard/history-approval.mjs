import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, basename, win32, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { promotionScreen, sourceRegistration } from '../research/history-optimization-20261002/replay.mjs';
import { candidates, suiteProtocol } from '../research/history-optimization-20261002/suite.mjs';

export const historyApprovalProtocol = Object.freeze({ version: 'paper-history-approval-v1',
  candidateId: 'p3-consensus', candidateEntry: 'forward-control', candidateExit: 'consensus',
  prerequisite: 'independently-recalculated-whole-history-screen-before-forward-adoption',
  sourceRoots: Object.freeze(['parallel-replay.mjs']), scope: 'paper-only',
  missingOrFailed: 'candidate-observation-continues-new-main-entries-market',
  changesExistingPositions: false, haltsMain: false, realTrading: false });
const digest = b => createHash('sha256').update(b).digest('hex');
const hash = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const baseReason = '历史验证未通过，候选继续观察';
const labDefault = fileURLToPath(new URL('../', import.meta.url));
const sorted = sources => Object.fromEntries(Object.entries(sources ?? {}).sort(([a], [b]) => a.localeCompare(b)));
export const historySourceRegistrationHash = sources => digest(JSON.stringify(sorted(sources)));

function validBinding(binding) {
  return binding?.candidateId === historyApprovalProtocol.candidateId &&
    ['reportSha256', 'registrationSha256', 'certificateSha256', 'sourceRegistrationHash'].every(k => hash(binding[k]));
}
function artifact(path) { const bytes = readFileSync(path); return { path, hash: digest(bytes), value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) }; }
// An approval stays immutable after a checkout move. Only a missing absolute
// artifact below the old lab's research directory may be relocated, and the
// replacement bytes must still match its externally pinned hash.
export function historyArtifactPath(approvalPath, declaredPath, expectedHash, labDirectory = labDefault) {
  const original = resolve(dirname(approvalPath), declaredPath);
  if (existsSync(original)) return original;
  if (!(isAbsolute(declaredPath) || win32.isAbsolute(declaredPath))) return original;
  const parts = declaredPath.replaceAll('\\', '/').split('/');
  const marker = parts.lastIndexOf(basename(resolve(labDirectory)));
  if (marker < 0 || parts[marker + 1] !== 'research') return original;
  const suffix = parts.slice(marker + 1);
  if (suffix.some(p => !p || p === '.' || p === '..')) return original;
  const migrated = resolve(labDirectory, ...suffix), within = relative(resolve(labDirectory), migrated);
  if (within.startsWith('..') || isAbsolute(within) || !existsSync(migrated)) return original;
  if (!hash(expectedHash) || digest(readFileSync(migrated)) !== expectedHash)
    throw Error('Relocated history artifact differs from immutable hash');
  return migrated;
}
function failure(code, candidateId = historyApprovalProtocol.candidateId, detail = null) {
  return { version: historyApprovalProtocol.version, candidateId, approved: false, status: 'history-unapproved', code,
    reason: baseReason, detail, policyForNewEntries: 'market', candidateObservationEnabled: true,
    haltsMain: false, affectsExistingPositions: false, realTrading: false };
}

/** Reads only pinned artifacts. The trusted binding belongs to the NEW immutable
 * coordinator registry, never to this mutable approval file itself. Neither
 * approval.eligible nor certificate.eligible is evidence of passing a screen.
 */
export function readHistoryApproval({ approvalPath, binding, labDirectory = labDefault, now = Date.now() } = {}) {
  if (!Number.isFinite(now)) return failure('invalid-clock');
  if (!validBinding(binding)) return failure('missing-immutable-history-binding');
  if (typeof approvalPath !== 'string' || !existsSync(approvalPath)) return failure('missing-history-approval');
  try {
    const approval = artifact(approvalPath).value;
    if (approval.version !== historyApprovalProtocol.version || approval.scope !== 'paper-only' ||
        approval.candidateId !== binding.candidateId || !Number.isFinite(approval.approvedAt) || approval.approvedAt > now)
      return failure('invalid-history-approval');
    if (['reportSha256', 'registrationSha256', 'certificateSha256', 'sourceRegistrationHash'].some(k => approval[k] !== binding[k]))
      return failure('approval-differs-from-immutable-binding');
    if (['reportPath', 'registrationPath', 'certificatePath'].some(k => typeof approval[k] !== 'string' || !approval[k]))
      return failure('missing-history-artifact-path');
    const read = k => artifact(historyArtifactPath(approvalPath, approval[k], binding[k.replace('Path', 'Sha256')], labDirectory));
    const reportArtifact = read('reportPath'), registrationArtifact = read('registrationPath'), certificateArtifact = read('certificatePath');
    if (reportArtifact.hash !== binding.reportSha256 || registrationArtifact.hash !== binding.registrationSha256 ||
        certificateArtifact.hash !== binding.certificateSha256) return failure('history-artifact-hash-mismatch');
    const report = reportArtifact.value, registration = registrationArtifact.value, certificate = certificateArtifact.value;
    if (report.version !== suiteProtocol.version || registration.version !== suiteProtocol.version || certificate.version !== suiteProtocol.version ||
        !Number.isFinite(report.cutoff) || report.cutoff > now || report.cutoff !== registration.cutoff ||
        !Number.isFinite(certificate.completedAt) || certificate.completedAt > approval.approvedAt ||
        !Number.isFinite(registration.declaredAt) || registration.declaredAt > certificate.completedAt ||
        certificate.realTrading !== false || certificate.reportSha256 !== reportArtifact.hash ||
        certificate.registrationSha256 !== registrationArtifact.hash || !Number.isInteger(report.frames) || report.frames <= 0)
      return failure('incomplete-or-future-history-certificate');
    if (!isDeepStrictEqual(registration.protocol, suiteProtocol) || !isDeepStrictEqual(registration.candidates, candidates) ||
        !isDeepStrictEqual(report.split, registration.split) ||
        !isDeepStrictEqual(report.sources, registration.sources) || !isDeepStrictEqual(certificate.sources, registration.sources) ||
        historySourceRegistrationHash(registration.sources) !== binding.sourceRegistrationHash)
      return failure('historical-source-registration-mismatch');
    const current = sourceRegistration(historyApprovalProtocol.sourceRoots);
    // File paths are from the transitive source closure. No mutable runtime file
    // or generated report belongs to sourceRegistration / codeHashes.
    if (!isDeepStrictEqual(sorted(current), sorted(registration.sources))) return failure('candidate-source-drift');
    for (const [path, expected] of Object.entries(registration.sources))
      if (digest(readFileSync(resolve(labDirectory, path))) !== expected) return failure('candidate-source-drift', binding.candidateId, path);
    const expectedKeys = suiteProtocol.scopes.flatMap(scope => suiteProtocol.scenarios.flatMap(s => candidates.map(c => `${scope}:${s.id}:${c.id}`)));
    if (!Array.isArray(report.accounts) || report.accounts.length !== expectedKeys.length ||
        new Set(report.accounts.map(a => `${a.scope}:${a.scenario}:${a.id}`)).size !== expectedKeys.length ||
        !expectedKeys.every(k => report.accounts.some(a => `${a.scope}:${a.scenario}:${a.id}` === k)))
      return failure('incomplete-full-history-accounts');
    const candidate = registration.candidates.filter(c => c.id === binding.candidateId);
    if (candidate.length !== 1 || candidate[0].entry !== historyApprovalProtocol.candidateEntry || candidate[0].exit !== historyApprovalProtocol.candidateExit)
      return failure('candidate-policy-mapping-mismatch');
    const reviewed = promotionScreen(report), verdict = reviewed.checks.filter(c => c.id === binding.candidateId);
    if (verdict.length !== 1 || verdict[0].pass !== true || !reviewed.eligible.includes(binding.candidateId))
      return failure('independent-history-screen-failed', binding.candidateId, verdict[0]?.reasons ?? null);
    return { version: historyApprovalProtocol.version, candidateId: binding.candidateId, approved: true,
      status: 'history-qualified', code: 'independently-verified', reason: '完整历史验证已独立复核；仍须通过原未来批次门槛',
      reportSha256: binding.reportSha256, registrationSha256: binding.registrationSha256,
      certificateSha256: binding.certificateSha256, sourceRegistrationHash: binding.sourceRegistrationHash,
      approvedAt: approval.approvedAt, completedAt: certificate.completedAt, checkedAt: now,
      policyForNewEntries: null, candidateObservationEnabled: true, haltsMain: false, affectsExistingPositions: false,
      realTrading: false, screen: verdict[0], artifactPaths: { approvalPath,
        reportPath: reportArtifact.path, registrationPath: registrationArtifact.path, certificatePath: certificateArtifact.path } };
  } catch (error) { return failure('invalid-history-artifact', binding.candidateId, error.message); }
}

// One registry gets one qualification decision. Missing/failed evidence is never
// retried into approval; a fresh immutable registration is required. An initially
// approved instance checks only metadata drift at most once per minute, and any
// drift permanently revokes its runtime approval. Approval is never written.
export class HistoryApprovalGate {
  constructor(options = {}) { this.options = structuredClone(options); this.lastSignature = null; this.cached = null; this.cachedAt = null; this.lastDriftCheckAt = null; }
  signature() {
    try {
      const { approvalPath, labDirectory = labDefault } = this.options;
      const paths = [approvalPath];
      if (typeof approvalPath === 'string' && existsSync(approvalPath)) {
        const a = JSON.parse(readFileSync(approvalPath, 'utf8').replace(/^\uFEFF/, ''));
        const resolved = {};
        for (const key of ['reportPath', 'registrationPath', 'certificatePath']) if (typeof a[key] === 'string') {
          resolved[key] = historyArtifactPath(approvalPath, a[key], this.options.binding?.[key.replace('Path', 'Sha256')], labDirectory);
          paths.push(resolved[key]);
        }
        if (typeof a.registrationPath === 'string') {
          const r = JSON.parse(readFileSync(resolved.registrationPath, 'utf8'));
          paths.push(...Object.keys(r.sources ?? {}).map(p => resolve(labDirectory, p)));
        }
      }
      return JSON.stringify({ binding: this.options.binding, files: paths.map(p => {
        if (typeof p !== 'string' || !existsSync(p)) return [p, 'missing'];
        const s = statSync(p); return [p, s.size, s.mtimeMs, s.ctimeMs];
      }) });
    } catch { return null; }
  }
  check(now = Date.now()) {
    if (!this.cached) {
      this.cached = readHistoryApproval({ ...this.options, now }); this.lastSignature = this.signature();
      this.cachedAt = now; this.lastDriftCheckAt = now;
      return structuredClone(this.cached);
    }
    if (!Number.isFinite(now) || now < this.cachedAt) return failure('history-check-before-registration');
    if (!this.cached.approved) return structuredClone(this.cached);
    if (now - this.lastDriftCheckAt >= 60000) {
      this.lastDriftCheckAt = now; const signature = this.signature();
      if (signature === null || signature !== this.lastSignature)
        this.cached = failure('history-evidence-changed-new-registration-required');
    }
    return structuredClone({ ...this.cached, checkedAt: now });
  }
}

export function historyGatedEvolutionPlan(current, proposed, approval) {
  return proposed?.effectivePolicy === 'consensus' && approval?.approved !== true ? current : proposed;
}
