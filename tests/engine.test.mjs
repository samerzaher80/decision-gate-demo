import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAudit, evaluate, policySummary, verifyAudit } from '../engine.js';

const now = new Date('2026-09-27T08:00:00Z');
function proposal(domain = 'refund') {
  const policy = policySummary(domain);
  return {
    id: 'synthetic-case', domain, action: policy.action,
    actor: { id: 'operator', permissions: [policy.authority] },
    context: { amount: 75, humanApproved: true, customerImpact: 'normal' },
    evidence: policy.required.map((kind, index) => ({ id: `e${index}`, kind, source: 'synthetic fixture', confidence: .96, observedAt: '2026-09-27T07:55:00Z', verified: true })),
  };
}

test('all gates pass for a low-risk, authorized refund', () => {
  const result = evaluate(proposal(), now);
  assert.equal(result.decision, 'execute');
  assert.equal(result.missing.length, 0);
  assert.equal(result.confidence, 96);
});

test('missing evidence asks; stale evidence defers', () => {
  const missing = proposal(); missing.evidence.pop();
  assert.equal(evaluate(missing, now).decision, 'ask');
  const stale = proposal(); stale.evidence[0].observedAt = '2026-09-27T05:00:00Z';
  assert.equal(evaluate(stale, now).decision, 'defer');
});

test('authority and policy denial fail closed', () => {
  const unauthorized = proposal(); unauthorized.actor.permissions = [];
  assert.equal(evaluate(unauthorized, now).decision, 'refuse');
  const overLimit = proposal(); overLimit.context.amount = 800;
  assert.equal(evaluate(overLimit, now).decision, 'refuse');
});

test('a deployment without named approval escalates', () => {
  const deploy = proposal('deploy'); deploy.context.humanApproved = false;
  assert.equal(evaluate(deploy, now).decision, 'escalate');
});

test('unverified evidence does not become current by assertion', () => {
  const unverified = proposal('moderation'); unverified.evidence[0].verified = false;
  const result = evaluate(unverified, now);
  assert.equal(result.decision, 'defer');
  assert.equal(result.evidence[0].reason, 'unverified');
});

test('hash-linked receipts detect altered decisions', async () => {
  const one = proposal(); const result = evaluate(one, now);
  const first = await appendAudit([], one, result);
  const second = await appendAudit([first], one, result);
  assert.equal(await verifyAudit([first, second]), true);
  const edited = structuredClone([first, second]); edited[0].result.decision = 'refuse';
  assert.equal(await verifyAudit(edited), false);
});

test('a valid rewritten chain fails an independently retained checkpoint', async () => {
  const {appendAudit,verifyAudit} = await import('../engine.js');
  const original = await appendAudit([], {id:'P1'}, {decision:'ask'});
  const rewritten = await appendAudit([], {id:'P1'}, {decision:'execute'});
  assert.equal(await verifyAudit([original],original.hash),true);
  assert.equal(await verifyAudit([rewritten]),true);
  assert.equal(await verifyAudit([rewritten],original.hash),false);
  assert.equal(await verifyAudit([],original.hash),false);
});