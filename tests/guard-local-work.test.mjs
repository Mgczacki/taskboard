import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const guard = new URL('../server/hooks/guard.mjs', import.meta.url);
test('quoted report text and filenames do not execute the operations they name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-local-guard-'));
  writeFileSync(join(dir, 'server.pid'), JSON.stringify({ pid: 123456 }));
  try {
    for (const agy of [false, true]) for (const command of [
      'pnpm test -- --test-name-pattern "pnpm release keeps its approval"',
      'npm test -- --test-name-pattern "release after pnpm"',
      'yarn test "release"', 'bun test "release"', 'npx tsx --test "release"',
      'node /Users/mariogarrido/AgentVault/tasks/taskboard-measure-mcp-server-ram-and-cpu-822/report-generator.mjs',
      'git show HEAD:scripts/release.mjs',
      'git log --grep="git push"',
      'git branch --contains 34b4cc51', 'git branch -a --sort=-committerdate', 'git stash list', 'git worktree list',
      'echo /Users/mariogarrido/.taskboard/urgent/example.json',
      'echo "kill 123456; kill server.pid 4317; tmux -L taskboard kill-server"',
      'echo "launchctl kickstart com.taskboard.server; node scripts/doctor.mjs --repair"',
      'echo "rm ~/.taskboard now"',
      'printf "%s" "pkill node; pnpm release; tb restart; gh pr merge 42"',
      'node report-generator.mjs "scripts/restart.mjs"',
      'node scripts/local-test.mjs "4317 kill server.pid"',
      'node -e "console.log(\'pnpm release\')"',
      'node -e "require(\'node:fs\').writeFileSync(\'/tmp/report.md\', \'pnpm release\')"',
      "cat > report.md <<'EOF'\npnpm release\nkill server.pid\nEOF",
      'cat > report.md <<EOF\npnpm release\nEOF',
      'node <<\'EOF\'\nconsole.log("pnpm release");\nEOF',
      'node --test tests/check.test.mjs | tail -20',
      'node --import tsx --test tests/guard-git.test.mjs tests/push-routes.test.ts',
      'python3 -c "print(\'pnpm release\')"',
      'python3 -c "from pathlib import Path; Path(\'/tmp/report.md\').write_text(\'pnpm release\')"',
      'pnpm sandbox stop', 'TASKBOARD_DIR=/tmp/local-test-only pnpm stop',
      'python3 - <<\'EOF\'\nfrom pathlib import Path\nPath("report.md").write_text("pnpm release")\nEOF',
      'node --check scripts/release.mjs',
      'node --test --test-name-pattern "release.mjs" tests/local.test.mjs',
    ]) {
      const result = spawnSync(process.execPath, [guard.pathname, ...(agy ? ['--agy'] : [])], {
        input: JSON.stringify(agy ? { toolCall: { args: { CommandLine: command } } } : { tool_input: { command } }),
        encoding: 'utf8', env: { ...process.env, TASK_ID: 'task-823', TASKBOARD_DIR: dir },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '', command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refusals name the one call and leave local work available for all agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-local-refusal-'));
  try {
    for (const agy of [false, true]) for (const command of [
      'pnpm release', 'npm run release', 'yarn rollback', 'bun run rollback', 'npx pnpm release',
      'node scripts/release.mjs', 'node scripts/rollback.mjs', 'node scripts/restart.mjs', 'tb restart',
      'pnpm stop', 'node scripts/stop.mjs',
      'env FOO=x bash -c "pnpm release"', 'echo "$(pnpm release)"',
      'node -e "require(\'node:child_process\').execSync(\'pnpm release\')"',
      'node -e "process.kill(Number(process.env.PID))"',
      'cat > report.md <<EOF\n$(pnpm release)\nEOF',
      'node <<\'EOF\'\nrequire("node:child_process").execSync("pnpm release");\nEOF',
      'printf "require(\'node:child_process\').execSync(\'pnpm release\')" | node',
      'node < scripts/release.mjs',
      'timeout 10 pnpm release', 'nice -n 5 pnpm release', 'command -p pnpm release', 'exec -a process pnpm release',
      'python3 -c "import subprocess; subprocess.run([\'pnpm\', \'release\'])"',
      'python3 - <<\'EOF\'\nimport subprocess\nsubprocess.run(["pnpm", "release"])\nEOF',
      'eval "pnpm release"', 'find . -exec pnpm release \\;',
      'node --test tests/local.test.mjs scripts/release.mjs',
      'pnpm exec pkill -f "tsx server/index.ts"',
      'pkill -f "tsx server/index.ts"', 'tmux -L taskboard kill-server',
      'git push origin master', 'gh --repo owner/repo pr merge 42',
      'git branch -D master', 'git branch feature master', 'git branch --list -D master',
      'pnpm deploy --env production', 'kubectl apply -f prod.yaml',
      'aws ecs update-service --cluster production --service app',
      'psql postgres://production/app -c "UPDATE users SET enabled=true"',
    ]) {
      const result = spawnSync(process.execPath, [guard.pathname, ...(agy ? ['--agy'] : [])], {
        input: JSON.stringify(agy ? { toolCall: { args: { CommandLine: command } } } : { tool_input: { command } }),
        encoding: 'utf8', env: { ...process.env, TASK_ID: 'task-823', TASKBOARD_DIR: dir },
      });
      assert.equal(result.status, 0);
      assert.notEqual(result.stdout, '', command);
      const output = JSON.parse(result.stdout);
      const reason = agy ? output.reason : output.hookSpecificOutput.permissionDecisionReason;
      assert.match(reason, /Refused call:/, command);
      assert.match(reason, /Only this call was refused.*Continue authorized local work/, command);
      assert.match(reason, /- File reads\./, command);
      assert.doesNotMatch(reason, /Stop and tell|stop your task|end your task/i, command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
