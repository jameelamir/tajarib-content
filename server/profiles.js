/**
 * Multi-user profiles — view-filter only, no auth.
 * Activates when WORKSPACE_DIR/profiles.json exists with shape:
 *   { "profiles": ["jameel", "editor"] }
 * Without the file, single-user mode (no UI, no filtering).
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { WORKSPACE_DIR } = ctx;
  const CANDIDATES = [
    path.join(WORKSPACE_DIR, "config", "profiles.json"),
    path.join(WORKSPACE_DIR, "profiles.json"),
  ];

  function loadProfiles() {
    const file = CANDIDATES.find(p => fs.existsSync(p));
    if (!file) return { enabled: false, profiles: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const profiles = Array.isArray(raw.profiles) ? raw.profiles.filter(p => typeof p === "string" && p.length > 0) : [];
      return { enabled: profiles.length > 0, profiles };
    } catch (_) {
      return { enabled: false, profiles: [] };
    }
  }

  function getProfileFromReq(req) {
    const raw = req.headers["x-profile"];
    if (!raw) return null;
    const val = String(raw).trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(val)) return null;
    return val;
  }

  function getScopeFromReq(req) {
    const raw = req.headers["x-scope"];
    const val = raw ? String(raw).trim().toLowerCase() : "all";
    return ["mine", "theirs", "all"].includes(val) ? val : "all";
  }

  return { loadProfiles, getProfileFromReq, getScopeFromReq };
};
