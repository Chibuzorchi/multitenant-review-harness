import path from 'node:path';
import { CLASSES } from '../lib/catalogue';
import { isAllowedHost, readEgressLog } from '../lib/egress-guard';
import { test, type OutboundLedgerLine } from '../lib/fixtures';
import { readJsonl, runPaths, writeJson } from '../lib/run';

/**
 * Runs last. Looks back over the whole review run and asserts that no process
 * (application, harness, browser) contacted or tried to contact a real
 * external host, and that the sink received exactly what the tests intended.
 */

const cls = CLASSES.uncontainedOutbound;
const isSelfTest = (host: string) => host.toLowerCase().endsWith('egress-selftest.invalid');

test('no external host was contacted during the run', async ({ target, review }) => {
  const application = target.logs.blockedEgress();
  const harness = readEgressLog('harness');
  const browser = readEgressLog('browser');
  const report = await target.outbound.egress();
  const unexpected = [
    ...application.filter((attempt) => !isSelfTest(attempt.host)).map((attempt) => ({ process: 'application', ...attempt })),
    ...harness.filter((attempt) => !isSelfTest(attempt.host)),
    ...browser.filter((attempt) => !isSelfTest(attempt.host)),
  ];
  const connected = Object.keys(report.allowed);
  const foreign = connected.filter((key) => {
    const host = key.slice(0, key.lastIndexOf(':'));
    return !isAllowedHost(host) && !report.allowHosts.includes(host);
  });
  const selfTests = { application: application.filter((attempt) => isSelfTest(attempt.host)).length, harness: harness.filter((attempt) => isSelfTest(attempt.host)).length, browser: browser.filter((attempt) => isSelfTest(attempt.host)).length };

  review.verify(unexpected.length === 0, { cls, key: 'containment/whole-run/blocked-attempts', title: 'A process attempted to contact an external host during the review', label: 'attempts refused by the egress guards', route: 'egress guards', expected: 'only the deliberate self-tests', actual: unexpected.length ? `${unexpected.length} unexpected attempt(s): ${[...new Set(unexpected.map((attempt) => attempt.host))].join(', ')}` : `none besides ${selfTests.application + selfTests.harness + selfTests.browser} self-test attempt(s)`, data: { unexpected }, signal: 'unexpected-external-attempt' });
  review.verify(foreign.length === 0, { cls, key: 'containment/whole-run/connections', title: 'The application connected to a host outside the review environment', label: 'connections made', route: 'application egress', expected: 'loopback or internal service names only', actual: connected.join(', ') || 'none', data: { foreign }, signal: 'external-connection-made' });
  review.verify(selfTests.application > 0 && selfTests.harness > 0 && selfTests.browser > 0, { cls: CLASSES.baselineMismatch, key: 'containment/whole-run/guards-live', title: 'An egress guard was not shown to be live during the run', label: 'self-tests recorded by every guard', route: 'egress guards', expected: 'at least one refused self-test per guard', actual: JSON.stringify(selfTests) });

  const ledger = readJsonl<OutboundLedgerLine>(runPaths.outboundLedger());
  const intended = new Set(ledger.flatMap((line) => line.event_ids));
  const received = (await target.outbound.received()).map((event) => event.id);
  const unintended = received.filter((id) => !intended.has(id));
  const lost = [...intended].filter((id) => !received.includes(id));
  const violations = ledger.filter((line) => !line.ok);
  review.verify(unintended.length === 0 && lost.length === 0 && violations.length === 0, { cls, key: 'containment/whole-run/sink-reconciliation', title: 'The sink received outbound events that no test intended', label: 'sink receipts against declared outbound events', route: 'outbound sink', expected: 'every receipt belongs to a test that declared it', actual: `${received.length} receipt(s); ${unintended.length} unintended; ${lost.length} missing; ${violations.length} test(s) exceeded their declaration`, data: { unintended, lost, violations: violations.map((line) => line.test) }, signal: 'undeclared-outbound-event' });

  writeJson(path.join(runPaths.evidence(), 'containment', 'egress-summary.json'), {
    run_id: runPaths.evidence().split(path.sep).pop(),
    allowed_destinations: report.allowHosts,
    connections_made_by_application: report.allowed,
    refused_attempts: { application: application.length, harness: harness.length, browser: browser.length },
    refused_attempts_that_were_self_tests: selfTests,
    unexpected_external_attempts: unexpected,
    sink: { receipts: received.length, declared_by_tests: intended.size, unintended: unintended.length, missing: lost.length },
    tests_with_outbound_declarations: ledger.filter((line) => line.declared > 0).map((line) => ({ stage: line.stage, test: line.test, declared: line.declared, refused: line.declared_blocked })),
    conclusion: unexpected.length === 0 && foreign.length === 0 ? 'No external host was contacted or attempted, other than the reserved .invalid names used to prove each guard refuses.' : 'External contact was attempted. See unexpected_external_attempts.',
  });
});
