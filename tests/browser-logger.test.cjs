const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'examples', 'browser-extension-logger.js'), 'utf8');

const loadLogger = () => {
  let stored = {};
  const chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get(defaults, callback) { callback({ ...defaults, ...stored }); },
      set(values, callback) { stored = structuredClone({ ...stored, ...values }); callback(); },
    } },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'browser-extension-logger.js' });
  return context.CodexAppLogger;
};

test('browser logger bounds events and redacts sensitive values', async () => {
  const logging = loadLogger();
  const logger = logging.create('example');
  for (let index = 0; index < 505; index += 1) {
    await logger.info('Example Event', {
      outcome: true,
      context: { index, apiKey: 'dummy-value', url: 'https://example.test/?token=dummy-value' },
    });
  }
  const logs = await logging.getRecent(500);
  assert.equal(logs.length, 500);
  assert.equal(logs[0].context.index, 504);
  assert.equal(logs[0].context.apiKey, '[REDACTED]');
  assert.equal(logs[0].context.url, 'https://example.test/?token=[REDACTED]');
});
