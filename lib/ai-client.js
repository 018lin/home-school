function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function shouldRetry(error, response) {
  if (error) return true;
  return !!response && (response.status === 408 || response.status === 425 ||
    response.status === 429 || response.status >= 500);
}

async function fetchWithTimeout(url, options, config) {
  config = config || {};
  const timeoutMs = Number(config.timeoutMs) || 30000;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options, config) {
  config = config || {};
  const retries = Math.max(0, Math.min(3, Number(config.retries == null ? 1 : config.retries)));
  const retryDelayMs = Math.max(50, Number(config.retryDelayMs) || 250);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response = null;
    try {
      response = await fetchWithTimeout(url, options, config);
      if (!shouldRetry(null, response) || attempt === retries) return response;
      await wait(retryDelayMs * Math.pow(2, attempt));
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      await wait(retryDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError || new Error("外部服务请求失败");
}

module.exports = { fetchWithTimeout, fetchWithRetry };
