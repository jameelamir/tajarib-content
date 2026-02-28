const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 7430;
const WORKSPACE_DIR = "/root/.openclaw/workspace/tajarib";
const PUBLIC_DIR = path.join(WORKSPACE_DIR, "public");

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8", (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading HTML");
        return;
      }
      res.writeHead(200, { 
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(data);
    });
    return;
  }
  
  if (req.url === "/api/episodes") {
    const EPISODES_DIR = path.join(WORKSPACE_DIR, "episodes");
    const eps = [];
    if (fs.existsSync(EPISODES_DIR)) {
      fs.readdirSync(EPISODES_DIR).forEach(slug => {
        const dir = path.join(EPISODES_DIR, slug);
        if (!fs.statSync(dir).isDirectory()) return;
        const metaPath = path.join(dir, "meta.json");
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
        eps.push({
          slug,
          mediaType: meta.mediaType || "episode",
          guest: meta.guest || "",
          role: meta.role || ""
        });
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(eps));
    return;
  }
  
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Test server on port", PORT);
});
