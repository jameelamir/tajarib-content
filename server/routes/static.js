/**
 * Static file serving — CORS, auth, index.html, public/ files.
 */
const fs = require("fs");
const path = require("path");

module.exports = async function staticRoute(req, res, url, ctx) {
  // CORS headers on every request
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return true; }

  // API routes are handled by other modules
  if (url.pathname.startsWith("/api/")) return false;

  // Main page
  if (req.method === "GET" && url.pathname === "/") {
    const indexPath = path.join(ctx.WORKSPACE_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(indexPath, "utf8"));
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("index.html not found");
    }
    return true;
  }

  // Static files from public/
  if (req.method === "GET") {
    const filePath = path.join(ctx.WORKSPACE_DIR, "public", url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = {
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.css': 'text/css',
        '.js': 'application/javascript'
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { "Content-Type": contentType });
      res.end(fs.readFileSync(filePath));
      return true;
    }
  }

  return false;
};
