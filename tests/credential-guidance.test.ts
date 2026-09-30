import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialGuidance } from '../server/credential-guidance.ts';

test('credential guidance uses one home for both sign-in and later checks', () => {
  const prompt = credentialGuidance('/Users/tester');
  assert.match(prompt, /CLOUDSDK_CONFIG=\/Users\/tester\/\.config\/gcloud/g);
  assert.match(prompt, /GOOGLE_APPLICATION_CREDENTIALS=\/Users\/tester\/\.config\/gcloud\/application_default_credentials\.json/g);
  assert.match(prompt, /GH_CONFIG_DIR=\/Users\/tester\/\.config\/gh/g);
  assert.match(prompt, /GIT_CONFIG_GLOBAL=\/Users\/tester\/\.gitconfig/g);
  assert.match(prompt, /command -v gcloud gh git/);
  assert.match(prompt, /print-access-token >\/dev\/null/);
  assert.match(prompt, /auth print-access-token >\/dev\/null/);
  assert.match(prompt, /Do not retry the original command/);
  assert.doesNotMatch(prompt, /Users\/mariogarrido/);
});
