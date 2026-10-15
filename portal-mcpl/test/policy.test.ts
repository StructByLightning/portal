/**
 * MCPL 0.5 capability-grant enforcement (SPEC §5.3, §5.4, §6.2, §6.4, §6.6, §6.7).
 *
 * The property under test throughout is that **absence of a capability is
 * denial**, never a default-allow, and that nothing the server says or is told
 * can widen what it may do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import { PortalAgent, shortJson, unknownToolMessage } from '../src/agent.js';
import { PortalMcplServer, voiceReceiptLine } from '../src/server.js';
import { featureSets, TOOL_FEATURE_SETS, toolFeatureSetCoverage } from '../src/feature-sets.js';
import {
  CAPABILITY_PATHS,
  MalformedPolicyError,
  McplPolicy,
  invalidUses,
  isCapabilityPath,
  pathMatches,
  type DeclaredFeatureSet,
} from '../src/policy.js';

const ALL_USES = [...new Set(Object.values(featureSets).flatMap((set) => set.uses as string[]))];

/** The operator log (console.error) while `run` runs. */
async function operatorLog(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

function policy(
  declarations: Readonly<Record<string, DeclaredFeatureSet>> = featureSets,
): McplPolicy {
  return new McplPolicy(declarations);
}

// ── §6.2 vocabulary ──

test('the capability vocabulary is exactly SPEC §6.2 / Appendix B.2', () => {
  assert.deepEqual(
    [...CAPABILITY_PATHS],
    [
      'pushEvents',
      'tools',
      'modelInfo',
      'inferenceRequest',
      'inferenceRequest.streaming',
      'inferenceLifecycle',
      'contextHooks.beforeInference.observe',
      'contextHooks.beforeInference.inject.system',
      'contextHooks.beforeInference.inject.beforeUser',
      'contextHooks.beforeInference.inject.afterUser',
      'channels.register',
      'channels.lifecycle',
      'channels.publish',
      'channels.incoming',
      'channels.streaming',
      'channels.acknowledge',
      'channels.typing',
    ],
  );
  // Plausible-looking non-members stay non-members.
  for (const bogus of ['channels', 'contextHooks', 'contextHooks.beforeInference', 'push', 'tools.call']) {
    assert.equal(isCapabilityPath(bogus), false, `${bogus} must not be a capability path`);
  }
});

test('every declared feature set declares a valid, non-empty uses (§6.4 rule 1)', () => {
  for (const [name, declaration] of Object.entries(featureSets)) {
    assert.equal(invalidUses(declaration), null, `${name} has invalid uses`);
  }
  assert.equal(invalidUses({ uses: undefined }), 'absent');
  assert.equal(invalidUses({ uses: [] }), 'empty');
  assert.equal(invalidUses({ uses: ['channels'] }), 'unrecognized: channels');
});

test('feature sets are keyed by name, not an array with a name member (§6.1)', () => {
  assert.equal(Array.isArray(featureSets), false);
  assert.deepEqual(Object.keys(featureSets).sort(), [
    'portal.channels',
    'portal.history',
    'portal.messaging',
    'portal.subscriptions',
    'portal.voice',
  ]);
  for (const declaration of Object.values(featureSets)) {
    assert.equal('name' in declaration, false);
    assert.equal(typeof declaration.description, 'string');
  }
});

test('every tool belongs to a declared feature set', () => {
  assert.deepEqual(toolFeatureSetCoverage(), { unmapped: [], unknownSets: [] });
});

// ── §5.4 matching ──

test('grant matching is a generic recursive walk; a bare prefix is not a subtree', () => {
  assert.equal(pathMatches('channels.publish', 'channels.publish'), true);
  assert.equal(pathMatches('channels.*', 'channels.publish'), true);
  assert.equal(pathMatches('channels', 'channels.publish'), false);
  assert.equal(pathMatches('contextHooks.*', 'contextHooks.beforeInference.inject.system'), true);
  assert.equal(pathMatches('contextHooks.beforeInference.inject.*', 'contextHooks.beforeInference.observe'), false);
  assert.equal(pathMatches('*', 'anything.at.all'), true);
});

// ── §5.3 initial policy ──

test('nothing is granted before the initial featureSets/update (§5.3)', () => {
  const p = policy();
  assert.equal(p.isReady, false);
  for (const path of CAPABILITY_PATHS) assert.equal(p.allows(path), false, path);
  for (const name of Object.keys(featureSets)) assert.equal(p.featureEnabled(name), false, name);
});

test('an empty grant enables nothing — "policy arrived" is not "allowed"', () => {
  const p = policy();
  const receipt = p.applyRequest({ effectiveCapabilities: [] });
  assert.equal(p.isReady, true);
  assert.equal(receipt.mode, 'degraded');
  assert.equal(receipt.unavailableFeatures.length, Object.keys(featureSets).length);
  for (const path of CAPABILITY_PATHS) assert.equal(p.allows(path), false, path);
});

// ── §6.4 derivation ──

test('a denied capability disables every set whose uses requires it (§6.4)', () => {
  const p = policy();
  const receipt = p.applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(p.featureEnabled('portal.messaging'), false);
  assert.equal(p.featureEnabled('portal.history'), true);
  const messaging = receipt.unavailableFeatures.find((f) => f.featureSet === 'portal.messaging');
  assert.equal(messaging?.reason, 'capability_denied');
  assert.deepEqual(messaging?.missingCapabilities, [
    'pushEvents',
    'channels.register',
    'channels.lifecycle',
    'channels.publish',
    'channels.incoming',
    'channels.acknowledge',
  ]);
});

test('an invalid uses disables that set with invalid_uses and nothing else (§6.4 rule 1)', () => {
  const p = policy({
    good: { uses: ['tools'] },
    bogus: { uses: ['channels.everything'] },
    empty: { uses: [] },
    absent: {},
  });
  const receipt = p.applyRequest({ effectiveCapabilities: ['tools', 'channels.everything'] });
  assert.equal(p.featureEnabled('good'), true);
  for (const name of ['bogus', 'empty', 'absent']) {
    assert.equal(p.featureEnabled(name), false, name);
    assert.equal(
      receipt.unavailableFeatures.find((f) => f.featureSet === name)?.reason,
      'invalid_uses',
    );
  }
  // The unrecognized path is not silently promoted into the grant either.
  assert.ok(receipt.notes.some((n) => n.includes('channels.everything')));
});

test('host selection narrows and never widens (§6.4 rule 3)', () => {
  const enabledOnly = policy().applyRequest({
    effectiveCapabilities: ALL_USES,
    enabled: ['portal.history'],
  });
  assert.deepEqual(
    enabledOnly.unavailableFeatures.filter((f) => f.reason === 'not_selected').map((f) => f.featureSet).sort(),
    ['portal.channels', 'portal.messaging', 'portal.subscriptions', 'portal.voice'],
  );

  const p = policy();
  p.applyRequest({ effectiveCapabilities: ['tools'], enabled: ['portal.messaging'] });
  assert.equal(
    p.featureEnabled('portal.messaging'),
    false,
    'naming a set in `enabled` must not supply the capabilities it lacks',
  );

  const wildcard = policy();
  wildcard.applyRequest({ effectiveCapabilities: ALL_USES, disabled: ['portal.*'] });
  for (const name of Object.keys(featureSets)) assert.equal(wildcard.featureEnabled(name), false, name);
});

// ── §5.4 deniedCapabilities is diagnostics ──

test('deniedCapabilities never authorizes, and a path in both lists fails closed (§5.4)', () => {
  const p = policy();
  p.applyRequest({ effectiveCapabilities: ['tools'], deniedCapabilities: ['pushEvents'] });
  assert.equal(p.allows('tools'), true);
  assert.equal(p.allows('pushEvents'), false);

  assert.throws(
    () => p.applyRequest({ effectiveCapabilities: ['tools'], deniedCapabilities: ['tools'] }),
    MalformedPolicyError,
  );
  assert.equal(p.isReady, false, 'a malformed policy drops back to fully denied');
  assert.equal(p.allows('tools'), false);
});

test('an unparseable member drops the whole message rather than half-applying it', () => {
  const p = policy();
  p.applyRequest({ effectiveCapabilities: ALL_USES });
  assert.equal(p.allows('channels.publish'), true);
  assert.throws(
    () => p.applyRequest({ effectiveCapabilities: ['tools'], disabled: [{ nope: true }] }),
    MalformedPolicyError,
  );
  assert.equal(
    p.allows('channels.publish'),
    false,
    'the previous, wider grant must not survive a rejected policy message',
  );
});

// ── §6.7 Request vs Notification ──

test('a Notification cannot establish a ready state or widen anything (§6.7)', () => {
  const p = policy();
  const diagnostics = p.applyNotification({
    effectiveCapabilities: ALL_USES,
    enabled: ['portal.messaging'],
  });
  assert.equal(p.isReady, false);
  assert.equal(p.allows('tools'), false);
  assert.equal(diagnostics.length, 2, 'both the grant and the expansion are refused and reported');
});

test('a reduction is respected immediately, even as a Notification (§6.7)', () => {
  const p = policy();
  p.applyRequest({ effectiveCapabilities: ALL_USES });
  assert.equal(p.featureEnabled('portal.messaging'), true);
  p.applyNotification({ disabled: ['portal.messaging'] });
  assert.equal(p.featureEnabled('portal.messaging'), false);
  assert.equal(p.featureEnabled('portal.history'), true);
});

test('the receipt is consequence testimony, never a claim of entitlement (§6.7)', () => {
  const receipt = policy().applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(Object.keys(receipt).sort(), ['accepted', 'mode', 'notes', 'unavailableFeatures']);
  for (const feature of receipt.unavailableFeatures) {
    assert.equal(feature.effect, 'disabled');
    // Nothing in the receipt names what the server should be given.
    assert.equal('requires' in feature, false);
    assert.equal('requested' in feature, false);
  }
});

// ── Server binding ──

function serverHarness() {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  const server = new PortalMcplServer(client, new PortalAgent(client, { hostOwnsChannelLifecycle: true }));
  const responses: unknown[] = [];
  const errors: Array<{ code: number; message: string }> = [];
  const internal = server as unknown as {
    conn: unknown;
    mcplEnabled: boolean;
    policy: McplPolicy;
    handleRequest(req: { id: number; method: string; params?: unknown }): Promise<void>;
  };
  internal.conn = {
    sendResponse(_id: number, result: unknown) {
      responses.push(result);
    },
    sendError(_id: number, code: number, message: string) {
      errors.push({ code, message });
    },
    sendNotification() {},
    async sendRequest() {
      return {};
    },
  };
  internal.mcplEnabled = true;
  return { server, internal, responses, errors };
}

test('before policy, the tool surface is empty and privileged methods are refused (§5.3, §6.6)', async () => {
  const h = serverHarness();
  await h.internal.handleRequest({ id: 1, method: 'tools/list' });
  assert.deepEqual(h.responses[0], { tools: [] });

  await h.internal.handleRequest({ id: 2, method: 'channels/publish', params: { channelId: 'portal:1', content: [] } });
  // §6.6: a method that will never be answered MUST return an error, not silence.
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].code, -32002);
});

test('a denied capability refuses the inbound method that needs it (§5.4, §14.1)', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ['tools'] });
  const logged = await operatorLog(() =>
    h.internal.handleRequest({ id: 1, method: 'channels/open', params: { channelId: 'portal:1' } }),
  );
  assert.equal(h.errors[0].code, -32002, 'channels/open requires channels.lifecycle');
  // The capability is the host's vocabulary: in the operator log, not the message.
  assert.ok(logged.some((line) => line.includes('channels/open refused: capability channels.lifecycle not granted')));
  assert.ok(!h.errors[0].message.includes('channels.lifecycle'));
  assert.match(h.errors[0].message, /^Nothing ran: this host hasn't granted Portal what this call needs/);
});

test('a tool whose feature set is disabled stops answering (§6.4, §6.6)', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(TOOL_FEATURE_SETS.send_message, 'portal.messaging');

  await h.internal.handleRequest({ id: 1, method: 'tools/list' });
  const listed = (h.responses[0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.equal(listed.includes('send_message'), false, 'portal.messaging is disabled');
  assert.equal(listed.includes('fetch_history'), true, 'portal.history only needs `tools`');

  const logged = await operatorLog(() =>
    h.internal.handleRequest({ id: 2, method: 'tools/call', params: { name: 'send_message', arguments: {} } }),
  );
  assert.equal(h.errors[0].code, -32001, 'feature set not enabled');
  assert.ok(logged.some((line) => line.includes('send_message refused: feature set not enabled: portal.messaging')));
  assert.match(h.errors[0].message, /^send_message isn't enabled for this host, so the call didn't run/);
});

test('a featureSets/update Request is answered even when it grants nothing (§5.3, §6.7)', async () => {
  const h = serverHarness();
  await h.internal.handleRequest({ id: 1, method: 'featureSets/update', params: { effectiveCapabilities: [] } });
  const receipt = h.responses[0] as { accepted: boolean; mode: string };
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, 'degraded');
  assert.equal(h.errors.length, 0);
});

test('a malformed featureSets/update is answered with an error and denies everything', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ALL_USES });
  await h.internal.handleRequest({
    id: 1,
    method: 'featureSets/update',
    params: { effectiveCapabilities: ['tools'], deniedCapabilities: ['tools'] },
  });
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].code, -32602);
  assert.equal(h.internal.policy.allows('tools'), false);
});

test('an unknown tool name is refused with the closest tools this host offers', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ALL_USES });
  await h.internal.handleRequest({ id: 1, method: 'tools/call', params: { name: 'send_mesage', arguments: {} } });
  assert.equal(h.errors[0].code, -32002);
  assert.equal(h.errors[0].message, 'There\'s no Portal tool named "send_mesage", so nothing ran. Did you mean "send_message"?');
  await h.internal.handleRequest({ id: 2, method: 'tools/call', params: { name: 'frobnicate', arguments: {} } });
  assert.equal(h.errors[1].message, 'There\'s no Portal tool named "frobnicate", so nothing ran. Call one of the tools listed for you.');
});

test('a tool that throws answers with its message alone, flagged isError', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ALL_USES });
  await h.internal.handleRequest({
    id: 1,
    method: 'tools/call',
    params: { name: 'send_message', arguments: { channelId: 42, content: 'hi' } },
  });
  assert.deepEqual(h.responses[0], {
    content: [{ type: 'text', text: 'Nothing ran: channelId must be a string, got 42.' }],
    isError: true,
  });
});

test('unknown-tool suggestions come from the tools this host has enabled', async () => {
  const h = serverHarness();
  // `tools` alone leaves portal.messaging disabled and portal.history enabled.
  h.internal.policy.applyRequest({ effectiveCapabilities: ['tools'] });
  await h.internal.handleRequest({ id: 1, method: 'tools/call', params: { name: 'send_mesage', arguments: {} } });
  assert.equal(h.errors[0].message, 'There\'s no Portal tool named "send_mesage", so nothing ran. Call one of the tools listed for you.');
  await h.internal.handleRequest({ id: 2, method: 'tools/call', params: { name: 'fetch_histroy', arguments: {} } });
  assert.equal(h.errors[1].message, 'There\'s no Portal tool named "fetch_histroy", so nothing ran. Did you mean "fetch_history"?');
  // An inherited property name isn't a declared tool.
  await h.internal.handleRequest({ id: 3, method: 'tools/call', params: { name: 'constructor', arguments: {} } });
  assert.match(h.errors[2].message, /^There's no Portal tool named "constructor", so nothing ran\./);
});

test("a retired tool reaches its pointer even when its feature set is disabled", async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(TOOL_FEATURE_SETS.set_reaction_visibility, 'portal.messaging');
  await h.internal.handleRequest({
    id: 1,
    method: 'tools/call',
    params: { name: 'set_reaction_visibility', arguments: { channelId: '1', visible: true } },
  });
  assert.equal(h.errors.length, 0);
  const result = h.responses[0] as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^set_reaction_visibility is retired here, so nothing ran: .*such as channel_open and channel_close\.$/);
});

test('channels/open and channels/close name the id they were given, and the form ids take', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: [...ALL_USES, 'channels.lifecycle'] });
  await h.internal.handleRequest({ id: 1, method: 'channels/open', params: { channelId: 'portal:999' } });
  assert.match(h.errors[0].message, /^No Portal channel matches "portal:999", so nothing was opened\. Portal channel ids look like portal:<id>/);
  await h.internal.handleRequest({ id: 2, method: 'channels/close', params: {} });
  assert.match(h.errors[1].message, /^Nothing was closed: null isn't a Portal channel id\. Portal channel ids look like portal:<id>/);
});

test('the unknown-tool refusal lists at most three near names, closest first, within the cutoff', () => {
  const tools = ['abcdef', 'abcdeg', 'abcdxx', 'abxxxx', 'zzzzzz', 'abcdez'].map((name) => ({ name }));
  // Distances from "abcdeh": 1, 1, 2, 4, 6, 1; the cutoff for six letters is max(2, 2) = 2.
  assert.equal(
    unknownToolMessage('abcdeh', tools),
    'There\'s no Portal tool named "abcdeh", so nothing ran. Did you mean "abcdef" or "abcdeg" or "abcdez"?',
  );
  // Closest first, whatever order the tools come in.
  assert.equal(
    unknownToolMessage('abcdxy', [{ name: 'abcdzz' }, { name: 'abcdxx' }]),
    'There\'s no Portal tool named "abcdxy", so nothing ran. Did you mean "abcdxx" or "abcdzz"?',
  );
  // A longer name allows more edits: fourteen letters allow four, so three deletions still match.
  assert.match(unknownToolMessage('gt_pndng_pings', [{ name: 'get_pending_pings' }]), /Did you mean "get_pending_pings"\?$/);
  assert.match(unknownToolMessage('abc', [{ name: 'xyz' }]), /Call one of the tools listed for you\.$/);
  assert.match(unknownToolMessage(42, [{ name: 'send_message' }]), /^There's no Portal tool named 42, so nothing ran\. Call one of the tools listed for you\.$/);
});

test('a voice receipt says what was said, and only an error suggests saying it again', () => {
  const base = {
    type: 'voice_receipt' as const, channelId: 'c', guildId: null, requestId: 'r',
    voicedText: '', unvoicedText: '', estimated: false, playedMs: 0, queuedMs: 0, billedChars: 0, at: 0,
  };
  assert.equal(
    voiceReceiptLine({ ...base, status: 'spoken', voicedText: 'hello', playedMs: 1500 }, '#v'),
    '[voice] you spoke in #v (1.5s): hello',
  );
  assert.equal(
    voiceReceiptLine({ ...base, status: 'refused', reason: 'no grant authority deployed' }, '#v'),
    '[voice] your utterance in #v was refused, so nothing was said: no grant authority deployed.',
  );
  assert.equal(
    voiceReceiptLine({ ...base, status: 'error', reason: 'TTS open failed: x' }, '#v'),
    '[voice] your utterance in #v was dropped by an error, so nothing was said: TTS open failed: x. Call voice_speak again if it still matters.',
  );
  assert.equal(
    voiceReceiptLine({ ...base, status: 'error', reason: 'stream lost', voicedText: 'hel', unvoicedText: 'lo', estimated: true }, '#v'),
    '[voice] your utterance in #v was cut off by an error: stream lost — heard: "hel" (boundary estimated) — unsaid: "lo". Call voice_speak with the rest if it still matters.',
  );
  assert.equal(
    voiceReceiptLine({ ...base, status: 'interrupted', voicedText: 'hel', unvoicedText: 'lo', interruptedBy: { userId: 'u', username: 'ann', bot: false } }, '#v'),
    '[voice] you were interrupted in #v by ann — heard: "hel" — unsaid: "lo"',
  );
});

test('a long value is cut to sixty characters, and a cut string keeps its closing quote', () => {
  assert.equal(shortJson('abc'), '"abc"');
  const cut = shortJson('x'.repeat(100));
  assert.equal(cut, `"${'x'.repeat(58)}…"`);
  assert.equal(shortJson(Array.from({ length: 40 }, (_, i) => i)).endsWith('…'), true);
});
