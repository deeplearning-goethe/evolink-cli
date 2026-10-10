import test from 'node:test';
import assert from 'node:assert/strict';
import { errorView, CliError } from '../src/errors.mjs';

test('CLI JSON and stderr projection bounds recursive details and strips upstream error data', () => {
  const cycle = {}; cycle.self = cycle;
  const out = errorView(new CliError('task_failed', 'Bearer sk-synthetic https://secret.upstream.test/account', {
    task: { error: { message: 'secret.upstream.test' }, results: [{ url: 'https://media.test/partial.png?signature=fixture' }] },
    api_key: 'sk-synthetic', cycle, values: Array(200).fill('secret.upstream.test'),
  }));
  assert.doesNotMatch(JSON.stringify(out), /sk-synthetic|secret\.upstream/);
  assert.equal(out.details.task.results[0].url, 'https://media.test/partial.png?signature=fixture');
  assert.equal(out.details.values.length, 100);
  assert.equal(out.details.cycle.self, '[truncated]');
});
