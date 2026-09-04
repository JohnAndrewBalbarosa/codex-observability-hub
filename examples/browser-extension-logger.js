// Generic browser-extension structured logging example.
//
// Logs are intentionally local-only and bounded. They are stored in
// chrome.storage.local when that API is available; MAIN-world scripts use the
// an extension bridge to ask the isolated-world script to read/write them.

(() => {
  if (globalThis.CodexAppLogger) return;

  const STORAGE_KEY = 'codexAppStructuredLogsV1';
  const MAX_ENTRIES = 500;
  const MAX_STRING = 500;
  const MAX_STACK = 1800;
  const SENSITIVE_KEY = /authorization|api.?key|token|cookie|password|secret|csrf|credential/i;
  const BEARER_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
  let writeQueue = Promise.resolve();

  const requestId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `app-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const cleanString = (value, limit = MAX_STRING) => String(value)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|api_key|key|token|secret)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, limit);

  const sanitize = (value, key = '', depth = 0) => {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return cleanString(value);
    if (value instanceof Error) {
      return {
        name: cleanString(value.name || 'Error', 80),
        message: cleanString(value.message || String(value)),
        stack: cleanString(value.stack || '', MAX_STACK),
      };
    }
    if (depth >= 3) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, '', depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
        out[childKey] = sanitize(childValue, childKey, depth + 1);
      }
      return out;
    }
    return cleanString(value);
  };

  const storageAvailable = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

  const storageGet = () => new Promise((resolve) => {
    chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
    });
  });

  const storageSet = (logs) => new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: logs.slice(-MAX_ENTRIES) }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });

  const bridgeRequest = (op, payload) => new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Extension logging storage is unavailable in this context'));
      return;
    }
    const id = requestId();
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`Extension logging bridge timed out during ${op}`));
    }, 3000);
    const onMessage = (event) => {
      const message = event.data;
      if (event.source !== window || message?.source !== 'extension-log-bridge' || message.dir !== 'res' || message.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (message.ok) resolve(message.data);
      else reject(new Error(message.error || `Extension logging bridge failed during ${op}`));
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'extension-log-bridge', dir: 'req', id, op, payload }, '*');
  });

  const normalize = (input) => ({
    timestamp: new Date().toISOString(),
    severity: ['debug', 'info', 'warn', 'error'].includes(input.severity) ? input.severity : 'info',
    event: cleanString(input.event || 'application.event', 120).toLowerCase().replace(/[^a-z0-9_.-]/g, '_'),
    component: cleanString(input.component || 'extension', 100),
    operation: cleanString(input.operation || input.event || 'unknown', 120),
    correlation_id: cleanString(input.correlation_id || requestId(), 100),
    outcome: input.outcome === false ? false : input.outcome === true ? true : null,
    message: input.message ? cleanString(input.message) : undefined,
    error: input.error ? sanitize(input.error, 'error') : undefined,
    context: input.context ? sanitize(input.context, 'context') : undefined,
  });

  const persist = (event) => {
    if (!storageAvailable()) return bridgeRequest('logEvent', event);
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const logs = await storageGet();
      logs.push(event);
      await storageSet(logs);
    });
    // Diagnostics must never break the application path they describe.
    return writeQueue.then(() => true, () => false);
  };

  const ingest = (input) => persist(normalize(sanitize(input)));

  const getRecent = async (limit = 100) => {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, MAX_ENTRIES));
    if (!storageAvailable()) return bridgeRequest('getLogs', { limit: safeLimit });
    const logs = await storageGet();
    return logs.slice(-safeLimit).reverse();
  };

  const clear = async () => {
    if (storageAvailable()) return storageSet([]);
    return bridgeRequest('clearLogs');
  };

  const create = (component) => {
    const emit = (severity, event, details = {}) => ingest({ ...details, severity, event, component });
    return Object.freeze({
      debug: (event, details) => emit('debug', event, details),
      info: (event, details) => emit('info', event, details),
      warn: (event, details) => emit('warn', event, details),
      error: (event, error, details = {}) => emit('error', event, { ...details, error, outcome: false }),
    });
  };

  const installGlobalHandlers = (component, sourceFilter) => {
    if (!globalThis.addEventListener) return;
    const logger = create(component);
    globalThis.addEventListener('error', (event) => {
      if (sourceFilter && !sourceFilter(event)) return;
      logger.error('runtime.uncaught_error', event.error || event.message, {
        operation: 'global_error_handler',
        context: { source: event.filename, line: event.lineno, column: event.colno },
      }).catch(() => {});
    });
    globalThis.addEventListener('unhandledrejection', (event) => {
      if (sourceFilter && !sourceFilter(event)) return;
      logger.error('runtime.unhandled_rejection', event.reason, {
        operation: 'global_rejection_handler',
      }).catch(() => {});
    });
  };

  globalThis.CodexAppLogger = Object.freeze({
    create,
    ingest,
    getRecent,
    clear,
    installGlobalHandlers,
    constants: Object.freeze({ STORAGE_KEY, MAX_ENTRIES }),
  });

  // The MAIN world also contains Canvas code, so only capture uncaught errors
  // whose source/stack points back to this extension. Explicit logger calls
  // remain available for failures that have already been caught.
  if (typeof window !== 'undefined' && !storageAvailable()) {
    installGlobalHandlers('dashboard', (event) => {
      const source = `${event.filename || ''} ${event.error?.stack || ''} ${event.reason?.stack || ''}`;
      return source.includes('chrome-extension://');
    });
  }
})();
