const { createRequestId } = require("./errors");

function createRequestContext(req) {
  const header = req && req.headers ? req.headers["x-request-id"] : "";
  return {
    requestId: header ? String(header).slice(0, 120) : createRequestId(),
    method: req && req.method ? req.method : "GET",
    startedAt: Date.now()
  };
}

module.exports = { createRequestContext };
