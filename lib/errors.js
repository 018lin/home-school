class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "ApiError";
    this.status = status || 500;
    this.code = code || "INTERNAL_ERROR";
  }
}

function createRequestId() {
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function errorPayload(error, requestId) {
  const status = Number(error && error.status) || 500;
  const message = status >= 500 ? "服务器暂时无法完成请求" : (error.message || "请求失败");
  return {
    message: message,
    errorCode: error && error.code ? error.code : (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
    requestId: requestId || null
  };
}

module.exports = { ApiError, createRequestId, errorPayload };
