const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const BLOCKED_PARTS = new Set([".git", "node_modules", "data", ".workbuddy"]);
const BLOCKED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.example",
  "package.json",
  "package-lock.json",
  "server.js",
  "database.js"
]);

function isBlockedPath(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.some(function (part) {
    const normalized = part.toLowerCase();
    return BLOCKED_PARTS.has(normalized) || normalized === ".env" || normalized.startsWith(".env.");
  }) || BLOCKED_FILES.has(parts[parts.length - 1].toLowerCase());
}

function createStaticServer(root) {
  const absoluteRoot = path.resolve(root);
  return function serveStatic(req, res, pathname) {
    let requestedPath = pathname === "/" ? "/index.html" : pathname;
    if (requestedPath.includes("\0")) {
      res.writeHead(400);
      return res.end("Bad Request");
    }
    const filePath = path.resolve(absoluteRoot, "." + requestedPath);
    const relativePath = path.relative(absoluteRoot, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath) ||
      isBlockedPath(relativePath)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!MIME[extension]) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }

    fs.readFile(filePath, function (error, data) {
      if (error) {
        res.writeHead(error.code === "EISDIR" ? 404 : 404, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        return res.end("404 Not Found");
      }
      res.writeHead(200, {
        "Content-Type": MIME[extension],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600"
      });
      res.end(data);
    });
  };
}

module.exports = { createStaticServer, MIME, isBlockedPath };
