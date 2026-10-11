import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { BrowserClickEvidence, clickEvidenceTools, visibilityFunction } from '../server/browser-click-evidence.ts';

const URL = 'https://example.test/agent-eval';
function harness() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let time = 0;
  const state = {
    selected: 32, url: URL, visible: true, removed: false, snapshotError: false,
    uid: '5_54', role: 'button', name: 'Route permissions', noise: 0,
  };
  const snapshot = (): CallToolResult => state.snapshotError
    ? { isError: true, content: [] }
    : { content: [{ type: 'text', text: 'Latest snapshot' }], structuredContent: {
      snapshot: { id: '5_0', role: 'RootWebArea', children: state.removed ? [] : [
        ...Array.from({ length: state.noise }, (_, i) => ({ id: `9_${i}`, role: 'button', name: 'Unrelated content '.repeat(50) })),
        { id: state.uid, role: state.role, name: state.name },
      ] },
    } };
  const evidence = new BrowserClickEvidence(async (name, args) => {
    calls.push({ name, args });
    if (name === 'take_snapshot') return snapshot();
    if (name === 'list_pages') return { content: [], structuredContent: { pages: [
      { id: 32, url: state.url, selected: state.selected === 32 },
      { id: 33, url: 'https://example.test/other', selected: state.selected === 33 },
    ] } };
    if (name === 'evaluate_script') {
      assert.deepEqual(args.args, ['5_54']);
      assert.equal(args.function, visibilityFunction);
      assert.equal(args.waitForStableDom, false);
      if (state.removed) return { isError: true, content: [] };
      return { content: [{ type: 'text', text: 'Script ran on page and returned:\n```json\n' +
        JSON.stringify({ visible: state.visible, url: state.url }) + '\n```' }] };
    }
    return { content: [{ type: 'text', text: name === 'click' ? 'clicked' : 'ok' }] };
  }, () => time);
  const prepare = async () => {
    await evidence.call('take_snapshot', { pageId: 32 });
    const result = await evidence.call('prepare_click', { pageId: 32, uid: '5_54' });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent!.target as Record<string, unknown>;
  };
  const click = (target: unknown, overrides = {}) => evidence.call('click', { pageId: 32, uid: '5_54', target, includeSnapshot: true, ...overrides });
  const blocked = (result: CallToolResult) => {
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(calls.filter(call => call.name === 'click').length, 0);
  };
  return { evidence, calls, state, prepare, click, blocked, advance: (ms: number) => { time += ms; } };
}

test('page 32 UID 5_54 carries exact target details into a reviewed click', async () => {
  const h = harness();
  const target = await h.prepare();
  assert.deepEqual({ ...target, receipt: 'opaque' }, {
    receipt: 'opaque', pageId: 32, uid: '5_54', url: URL, role: 'button', name: 'Route permissions',
  });
  const result = await h.click(target);
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(h.calls.at(-1), { name: 'click', args: { pageId: 32, uid: '5_54', includeSnapshot: true } });
  assert.equal(h.calls.filter(call => call.name === 'evaluate_script').length, 3);
  assert.equal(h.calls.filter(call => call.name === 'take_snapshot').length, 2);
});

test('stable UID remains valid across fresh snapshots regardless of its numeric prefix', async () => {
  const h = harness();
  await h.prepare();
  await h.evidence.call('take_snapshot', { pageId: 32 });
  const target = (await h.evidence.call('prepare_click', { pageId: 32, uid: '5_54' })).structuredContent!.target;
  assert.ok(!(await h.click(target)).isError);
});

test('large snapshot produces bounded evidence with the requested UID and exact name', async () => {
  const h = harness();
  h.state.noise = 300;
  const target = await h.prepare();
  assert.equal(target.uid, '5_54');
  assert.equal(target.name, 'Route permissions');
  assert.ok(JSON.stringify(target).length < 3000);
  assert.ok(!(await h.click(target)).isError);
});

test('missing snapshot and missing UID cannot prepare a click', async () => {
  const h = harness();
  h.blocked(await h.evidence.call('prepare_click', { pageId: 32, uid: '5_54' }));
  await h.evidence.call('take_snapshot', { pageId: 32 });
  h.blocked(await h.evidence.call('prepare_click', { pageId: 32, uid: '5_540' }));
});

for (const [name, change] of [
  ['hidden DOM element', (h: ReturnType<typeof harness>) => { h.state.visible = false; }],
  ['removed DOM element', (h: ReturnType<typeof harness>) => { h.state.removed = true; }],
  ['wrong selected page', (h: ReturnType<typeof harness>) => { h.state.selected = 33; }],
  ['changed URL', (h: ReturnType<typeof harness>) => { h.state.url += '/new'; }],
  ['changed accessible name', (h: ReturnType<typeof harness>) => { h.state.name = 'Delete group'; }],
  ['changed role', (h: ReturnType<typeof harness>) => { h.state.role = 'checkbox'; }],
  ['failed snapshot refresh', (h: ReturnType<typeof harness>) => { h.state.snapshotError = true; }],
  ['expired receipt', (h: ReturnType<typeof harness>) => { h.advance(300001); }],
] as const) {
  test(`${name} blocks a prepared click`, async () => {
    const h = harness();
    const target = await h.prepare();
    change(h);
    h.blocked(await h.click(target));
  });
}

test('hidden and wrong-page UIDs cannot prepare a click', async () => {
  const h = harness();
  await h.evidence.call('take_snapshot', { pageId: 32 });
  h.state.visible = false;
  h.blocked(await h.evidence.call('prepare_click', { pageId: 32, uid: '5_54' }));
  h.state.visible = true;
  h.blocked(await h.evidence.call('prepare_click', { pageId: 33, uid: '5_54' }));
  h.state.selected = 33;
  h.blocked(await h.evidence.call('prepare_click', { pageId: 32, uid: '5_54' }));
});

test('fresh snapshot invalidates old receipts even when the UID remains visible', async () => {
  const h = harness();
  const target = await h.prepare();
  await h.evidence.call('take_snapshot', { pageId: 32 });
  h.blocked(await h.click(target));
});

test('latest snapshot removes a stale UID and cannot prepare it', async () => {
  const h = harness();
  await h.prepare();
  h.state.removed = true;
  await h.evidence.call('take_snapshot', { pageId: 32 });
  h.blocked(await h.evidence.call('prepare_click', { pageId: 32, uid: '5_54' }));
});

test('fabricated, changed, absent, reused, and wrong-page receipts cannot click', async () => {
  for (const change of [
    (target: Record<string, unknown>) => ({ ...target, receipt: 'fabricated' }),
    (target: Record<string, unknown>) => ({ ...target, name: 'Other' }),
    () => undefined,
  ]) {
    const h = harness();
    h.blocked(await h.click(change(await h.prepare())));
  }
  const h = harness();
  h.blocked(await h.click(await h.prepare(), { pageId: 33 }));
  const another = harness();
  const target = await another.prepare();
  assert.ok(!(await another.click(target)).isError);
  assert.equal((await another.click(target)).isError, true);
  assert.equal(another.calls.filter(call => call.name === 'click').length, 1);
});

test('page mutations and snapshots saved to files invalidate receipts', async () => {
  const h = harness();
  const target = await h.prepare();
  await h.evidence.call('select_page', { pageId: 33 });
  h.blocked(await h.click(target));
  h.blocked(await h.evidence.call('prepare_click', { pageId: 32, uid: '5_54' }));
  const evidence = new BrowserClickEvidence(async () => ({ content: [], structuredContent: { snapshotFilePath: '/tmp/snapshot' } }));
  await evidence.call('take_snapshot', { pageId: 32, filePath: '/tmp/snapshot' });
  assert.equal((await evidence.call('prepare_click', { pageId: 32, uid: '5_54' })).isError, true);
});

test('click schema requires target details and retains ordinary tool annotations', () => {
  const tool: Tool = { name: 'click', description: 'Click', annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] } };
  const tools = clickEvidenceTools([tool]);
  assert.deepEqual(tools[0].inputSchema.required, ['uid', 'pageId', 'target']);
  assert.equal(tools[0].annotations?.readOnlyHint, false);
  assert.equal(tools[1].name, 'prepare_click');
  assert.equal(tools[1].annotations?.readOnlyHint, true);
});
