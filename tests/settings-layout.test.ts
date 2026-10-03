import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECTIONS, filterSettings, matcher, settingText } from '../web/src/settingsIndex.ts';

const source = ['Settings', 'SettingsLayout', 'Accounts', 'MessageLevels', 'Integrations', 'RulesFiles']
  .map(name => readFileSync(new URL(`../web/src/components/${name}.tsx`, import.meta.url), 'utf8')).join('\n');
const settings = SECTIONS.flatMap(s => s.groups.flatMap(g => g.settings));
const ids = settings.map(d => d.id);

// The label of each setting on the Settings page before the page had sections. The redesign keeps every one.
const LABELS_BEFORE = [
  'The controller may create and manage tasks without asking',
  'Other agents may start, type into, set aside and archive tasks without asking',
  'Extra folders for permit steps',
  'Pushes of task branches to my own repositories',
  'Other repositories I own, one owner/repository per line',
  'Extra protected branches, one per line',
  'Push history',
  'A2A Notes (Slack)',
  'Check drafts for private working notes and internal terms',
  'Trusted people',
  'Default maximum tasks per account',
  'Apply to all accounts…',
  'The controller may approve low risk suggestions',
  'Rules for choosing an agent and account',
  'Trust each task folder before an agent starts',
  'Review tool requests automatically',
  'Review account',
  'Review model',
  'Ask before ⏻ in a window header ends and archives the task',
  'Reset all keys',
  'Reload automatically when Taskboard is updated',
  'Start the controller with Taskboard and keep it running',
  'Controller: skip permission prompts',
  'Controller model for',
  'Remote Control: reach the controller from the Claude app as',
  "label: 'Who lets an incoming message reach your agents'",
  "label: 'Who approves a message that your agents send'",
  '<label className="opt">Agent <select',
  '<label className="opt">Account <select',
  '<label className="opt">Model <select',
  '<label className="opt">Model <input',
];

test('every setting label from before the redesign is still on the page', () => {
  for (const label of LABELS_BEFORE) assert.ok(source.includes(label), label);
});

test('each setting has one id, and the page wraps each id in a SettingItem', () => {
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(SECTIONS.map(s => s.id)).size, SECTIONS.length);
  for (const id of ids) assert.ok(source.includes(`id="${id}"`) || source.includes(`'${id}'`), id);
});

test('each setting label in the section list is text on the page', () => {
  for (const d of settings) assert.ok(source.includes(d.label), d.label);
});

test('the page renders one SettingSection for each section, in the same order', () => {
  const page = readFileSync(new URL('../web/src/components/Settings.tsx', import.meta.url), 'utf8');
  const order = [...page.matchAll(/<SettingSection id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, SECTIONS.map(s => s.id));
});

test('the Rules files section holds the controller and task session rules', () => {
  const f = filterSettings('rules');
  assert.equal(f.count('rules'), 2);
  assert.equal(f.shows('controllerRules'), true);
  assert.equal(f.shows('taskRules'), true);
  assert.equal(filterSettings('claude.md').shows('taskRules'), true);
});

test('an empty search shows every setting', () => {
  const f = filterSettings('  ');
  assert.equal(f.total, ids.length);
  for (const id of ids) assert.equal(f.shows(id), true);
});

test('every word of the search must match, in any case and with or without accents', () => {
  const f = filterSettings('REVIEW model');
  assert.equal(f.shows('reviewModel'), true);
  assert.equal(f.shows('reviewAccount'), false);
  assert.equal(f.shows('askModel'), false);
  assert.equal(f.count('sessions'), 1);
  assert.equal(f.groupShows('sessions', 'start'), true);
  assert.equal(f.groupShows('sessions', 'ask'), false);
  assert.equal(matcher('résumé')!('Resume the task'), true);
});

test('a section title matches all settings in that section', () => {
  const f = filterSettings('pushes');
  for (const id of ['pushTaskBranches', 'ownRepositories', 'protectedBranches', 'pushHistory']) assert.equal(f.shows(id), true);
  assert.equal(f.shows('routingRules'), false);
});

test('the search finds a setting by a word that is only in its extra words', () => {
  assert.equal(filterSettings('github').shows('ownRepositories'), true);
  assert.ok(settingText('controllerSkipPermissions').includes('--dangerously-skip-permissions'));
  assert.equal(filterSettings('dangerously').shows('controllerSkipPermissions'), true);
  assert.equal(filterSettings('bypass sandbox').shows('controllerSkipPermissions'), true);
  assert.equal(filterSettings('antigravity').shows('controllerAgent'), true);
});

test('extra search text from the page shows the keyboard shortcuts', () => {
  assert.equal(filterSettings('sidebar').shows('keyboardShortcuts'), false);
  const f = filterSettings('sidebar', { keyboardShortcuts: 'Anywhere Hide or show the sidebar' });
  assert.equal(f.shows('keyboardShortcuts'), true);
  assert.equal(f.total, 1);
});

test('a search with no match shows nothing', () => {
  const f = filterSettings('zzzq');
  assert.equal(f.total, 0);
  for (const s of SECTIONS) assert.equal(f.count(s.id), 0);
});
