import { appendAudit, evaluate, policySummary, verifyAudit } from './engine.js';

const SCENARIOS = {
  refund: { id: 'RF-1048', title: 'Approve a $75 refund', description: 'A support agent proposes refunding a duplicate payment. The order, payment, and current refund policy must agree before approval.', amount: 75, humanApproved: true, confidence: [0.98, 0.96, 0.94] },
  deploy: { id: 'DP-0182', title: 'Deploy release 2.7.1', description: 'The build and tests pass, but the change needs a named release approver. A green pipeline does not grant authority.', amount: 0, humanApproved: false, confidence: [0.99, 0.97, 0.96] },
  moderation: { id: 'MD-0039', title: 'Remove a reported post', description: 'A policy match and source content are present. A review trace is intentionally absent, so the gate must ask for it.', amount: 0, humanApproved: true, confidence: [0.98, 0.89, 0.91], baselineMissing: true },
};

const $ = (id) => document.getElementById(id);
let domain = 'refund';
let chain = [];

function titleCase(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function isoMinutesAgo(minutes) { return new Date(Date.now() - minutes * 60000).toISOString(); }

function makeProposal(selectedDomain, fault) {
  const scenario = SCENARIOS[selectedDomain];
  const policy = policySummary(selectedDomain);
  const evidence = policy.required.map((kind, index) => ({ id: `${scenario.id}-E${index + 1}`, kind, source: ['system record', 'independent check', 'signed policy'][index], observedAt: isoMinutesAgo(index + 4), confidence: scenario.confidence[index], verified: true }));
  if (scenario.baselineMissing) evidence.pop();
  if (fault === 'stale' && evidence.length) evidence[0].observedAt = isoMinutesAgo(policy.maxAgeMinutes + 10);
  if (fault === 'missing' && evidence.length) evidence.pop();
  return { id: scenario.id, domain: selectedDomain, action: policy.action, actor: { id: 'synthetic-operator', permissions: fault === 'authority' ? [] : [policy.authority] }, context: { amount: scenario.amount, humanApproved: scenario.humanApproved, prohibited: fault === 'prohibited', customerImpact: 'normal' }, evidence };
}

function renderScenario() {
  const scenario = SCENARIOS[domain];
  const policy = policySummary(domain);
  $('caseTitle').textContent = scenario.title;
  $('caseDescription').textContent = scenario.description;
  $('caseId').textContent = `CASE / ${scenario.id}`;
  $('metaDomain').textContent = titleCase(domain);
  $('metaReversibility').textContent = titleCase(policy.reversibility);
  $('metaAuthority').textContent = policy.authority;
  document.querySelectorAll('.scenario').forEach((button) => button.classList.toggle('active', button.dataset.domain === domain));
  $('fault').value = 'none';
  renderEvidence(makeProposal(domain, 'none'), null);
  $('decision').textContent = '—';
  $('decision').className = 'decision idle';
  $('confidence').textContent = '—';
  $('risk').textContent = '—';
  $('reason').textContent = 'Run the policy engine to see the decision and its reasons.';
  $('missing').textContent = 'MISSING / —';
  $('evaluatedAt').textContent = 'Waiting for evaluation';
}

function renderEvidence(proposal, result) {
  const policy = policySummary(proposal.domain);
  const rows = policy.required.map((kind) => {
    const item = result?.evidence.find((candidate) => candidate.kind === kind) ?? proposal.evidence.find((candidate) => candidate.kind === kind);
    const status = !item ? 'missing' : result ? (item.valid ? 'current' : item.reason) : 'provided';
    const source = item ? item.source : 'No source received';
    return `<div class="evidence-row"><div><span class="evidence-mark ${escapeHtml(status)}"></span><strong>${escapeHtml(kind.replaceAll('_', ' '))}</strong><small>${escapeHtml(source)}</small></div><span class="evidence-status">${escapeHtml(status.toUpperCase())}</span></div>`;
  });
  $('evidenceList').innerHTML = rows.join('');
  $('evidenceCount').textContent = `${proposal.evidence.length} SOURCES`;
}

function renderResult(result) {
  $('decision').textContent = result.decision.toUpperCase();
  $('decision').className = `decision ${result.decision}`;
  $('confidence').textContent = `${result.confidence}%`;
  $('risk').textContent = `${result.risk}/100`;
  $('reason').textContent = result.reasons.join(' ');
  $('missing').textContent = `MISSING / ${result.missing.length ? result.missing.join(', ') : 'NONE'}`;
  $('review').textContent = result.note;
  $('evaluatedAt').textContent = new Date(result.evaluatedAt).toLocaleTimeString();
}

function renderAudit() {
  $('auditList').innerHTML = chain.slice().reverse().map((entry) => `<div class="audit-entry"><div class="audit-entry-head"><strong>#${entry.sequence} ${escapeHtml(entry.result.decision.toUpperCase())}</strong><span>${escapeHtml(entry.proposal.id)}</span></div><p>${escapeHtml(entry.result.reasons[0])}</p><code>${entry.hash.slice(0, 16)}…</code></div>`).join('') || '<p class="audit-empty">No decisions recorded yet.</p>';
  $('export').disabled = chain.length === 0;
  $('checkpoint').textContent = chain.at(-1)?.hash ?? 'No entries yet';
  $('checkpoint').style.overflowWrap = 'anywhere';
}

document.querySelectorAll('.scenario').forEach((button) => button.addEventListener('click', () => { domain = button.dataset.domain; renderScenario(); }));
$('fault').addEventListener('change', () => renderEvidence(makeProposal(domain, $('fault').value), null));
$('evaluate').addEventListener('click', async () => {
  const proposal = makeProposal(domain, $('fault').value);
  const result = evaluate(proposal);
  chain = [...chain, await appendAudit(chain, proposal, result)];
  renderEvidence(proposal, result);
  renderResult(result);
  renderAudit();
  $('integrity').textContent = (await verifyAudit(chain)) ? 'VERIFIED' : 'BROKEN';
  $('integrity').className = (await verifyAudit(chain)) ? 'verified' : 'broken';
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ title: 'Decision Gate synthetic demo', exportedAt: new Date().toISOString(), entries: chain }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'decision-gate-audit.json';
  anchor.click();
  URL.revokeObjectURL(url);
});

renderScenario();

$('verifyExport').addEventListener('click', async () => {
  const checkpoint = $('expectedHead').value.trim().toLowerCase();
  const file = $('verifyFile').files[0];
  const status = $('exportStatus');
  if (!file || !/^[a-f0-9]{64}$/.test(checkpoint)) {
    status.textContent = 'Choose an audit export and enter its separately saved checkpoint.';
    return;
  }
  try {
    const {entries} = JSON.parse(await file.text());
    status.textContent = await verifyAudit(entries, checkpoint)
      ? 'Verified against trusted checkpoint.' : 'Chain or checkpoint mismatch.';
  } catch {
    status.textContent = 'Could not read this audit export.';
  }
});