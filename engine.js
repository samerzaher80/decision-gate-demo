export const DECISIONS = Object.freeze(['execute', 'ask', 'defer', 'escalate', 'refuse']);

const POLICIES = Object.freeze({
  refund: {
    action: 'approve_refund',
    required: ['order_record', 'payment_record', 'refund_policy'],
    authority: 'refund:approve',
    maxAmount: 100,
    hardLimit: 500,
    maxAgeMinutes: 60,
    baseRisk: 18,
    reversibility: 'partial',
  },
  deploy: {
    action: 'deploy_release',
    required: ['build_result', 'test_result', 'change_approval'],
    authority: 'release:deploy',
    maxAgeMinutes: 30,
    baseRisk: 32,
    reversibility: 'rollback-dependent',
  },
  moderation: {
    action: 'remove_content',
    required: ['content_record', 'policy_match', 'review_trace'],
    authority: 'moderation:remove',
    maxAgeMinutes: 120,
    baseRisk: 24,
    reversibility: 'reversible',
  },
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function evaluate(proposal, now = new Date()) {
  if (!isRecord(proposal) || !POLICIES[proposal.domain]) {
    throw new Error('Unknown or malformed proposal domain');
  }
  const policy = POLICIES[proposal.domain];
  if (proposal.action !== policy.action || !Array.isArray(proposal.evidence) || !isRecord(proposal.actor)) {
    throw new Error('Proposal action, evidence, or actor is malformed');
  }
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid evaluation time');

  const evidence = proposal.evidence.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.kind !== 'string') {
      throw new Error('Malformed evidence');
    }
    const observedMs = new Date(item.observedAt).getTime();
    const ageMinutes = Number.isFinite(observedMs) ? (nowMs - observedMs) / 60000 : Infinity;
    const confidence = Number(item.confidence);
    return {
      id: item.id,
      kind: item.kind,
      source: String(item.source || 'unspecified'),
      confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0,
      ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null,
      valid: item.verified === true && ageMinutes >= 0 && ageMinutes <= policy.maxAgeMinutes,
      reason: item.verified !== true ? 'unverified' : ageMinutes < 0 ? 'future timestamp' : ageMinutes > policy.maxAgeMinutes ? 'stale' : 'current',
    };
  });

  const matched = new Map();
  for (const item of evidence) {
    if (policy.required.includes(item.kind) && !matched.has(item.kind)) matched.set(item.kind, item);
  }
  const missing = policy.required.filter((kind) => !matched.has(kind));
  const stale = policy.required.filter((kind) => matched.has(kind) && !matched.get(kind).valid);
  const current = policy.required.map((kind) => matched.get(kind)).filter((item) => item?.valid);
  const evidenceConfidence = current.length === 0 ? 0 : current.reduce((sum, item) => sum + item.confidence, 0) / current.length;
  const coverage = current.length / policy.required.length;
  const confidence = Math.round(100 * coverage * evidenceConfidence);
  const amount = Number(proposal.context?.amount ?? 0);
  const amountRisk = proposal.domain === 'refund' && Number.isFinite(amount) ? clamp(Math.round(amount / 10), 0, 35) : 0;
  const risk = clamp(policy.baseRisk + amountRisk + missing.length * 12 + stale.length * 15 + (proposal.context?.customerImpact === 'high' ? 24 : 0), 0, 100);
  const permission = Array.isArray(proposal.actor.permissions) && proposal.actor.permissions.includes(policy.authority);
  const hasHumanApproval = proposal.context?.humanApproved === true;
  const reasons = [];
  let decision;

  if (proposal.context?.prohibited === true || (proposal.domain === 'refund' && (!Number.isFinite(amount) || amount > policy.hardLimit || amount < 0))) {
    decision = 'refuse';
    reasons.push('POLICY_DENY: prohibited action or refund beyond the hard limit.');
  } else if (!permission) {
    decision = 'refuse';
    reasons.push(`AUTHORITY_DENY: actor lacks ${policy.authority}.`);
  } else if (stale.length > 0) {
    decision = 'defer';
    reasons.push(`EVIDENCE_STALE: refresh ${stale.join(', ')} before reconsidering.`);
  } else if (missing.length > 0) {
    decision = 'ask';
    reasons.push(`EVIDENCE_MISSING: request ${missing.join(', ')}.`);
  } else if (risk >= 60 || (proposal.domain === 'refund' && amount > policy.maxAmount) || (proposal.domain === 'deploy' && !hasHumanApproval)) {
    decision = 'escalate';
    reasons.push('HUMAN_GATE: risk or policy threshold requires a named reviewer.');
  } else if (confidence < 70) {
    decision = 'ask';
    reasons.push('LOW_CONFIDENCE: obtain stronger source evidence.');
  } else {
    decision = 'execute';
    reasons.push('ALL_GATES_PASS: authority, evidence, risk, and review requirements satisfied.');
  }

  return {
    decision,
    confidence,
    risk,
    reasons,
    evidence,
    missing,
    reversibility: policy.reversibility,
    requiredAuthority: policy.authority,
    evaluatedAt: new Date(nowMs).toISOString(),
    note: 'Advisory decision only. This demo does not execute refunds, deploy code, or remove content.',
  };
}

export async function appendAudit(chain, proposal, result) {
  if (!Array.isArray(chain)) throw new Error('Audit chain must be an array');
  const previousHash = chain.length ? chain.at(-1).hash : 'GENESIS';
  const entry = {
    sequence: chain.length + 1,
    previousHash,
    proposal: JSON.parse(JSON.stringify(proposal)),
    result: JSON.parse(JSON.stringify(result)),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  entry.hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return entry;
}

export async function verifyAudit(chain, expectedHead) {
  if (!Array.isArray(chain)) return false;
  let previousHash = 'GENESIS';
  for (let index = 0; index < chain.length; index += 1) {
    if (!chain[index] || typeof chain[index] !== 'object') return false;
    const { hash, ...entry } = chain[index];
    if (entry.sequence !== index + 1 || entry.previousHash !== previousHash || typeof hash !== 'string') return false;
    const bytes = new TextEncoder().encode(JSON.stringify(entry));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== expected) return false;
    previousHash = hash;
  }
  return expectedHead === undefined || (chain.length > 0 && previousHash === expectedHead);
}

export function policySummary(domain) {
  const policy = POLICIES[domain];
  if (!policy) throw new Error('Unknown domain');
  return { ...policy, required: [...policy.required] };
}
