#!/usr/bin/env node
/**
 * Bump the patch version in package.json and mirror it into src/lib/version.ts.
 *
 * Invoked by the pre-commit hook so every commit carries an incremented patch
 * number. Re-stages both files when run inside a commit.
 *
 * Skips the bump when package.json is already staged with a different version
 * than HEAD (i.e. the developer bumped it deliberately in this commit).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const versionTsPath = path.join(root, "src", "lib", "version.ts");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const pkgRaw = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw);
const current = String(pkg.version || "0.0.0");

const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
if (!m) {
  console.error(`[bump-version] package.json version "${current}" is not semver; skipping.`);
  process.exit(0);
}

// Respect a manual bump already staged in this commit.
const headPkg = git(["show", "HEAD:package.json"]);
if (headPkg) {
  try {
    const headVersion = String(JSON.parse(headPkg).version || "");
    if (headVersion && headVersion !== current) {
      console.log(`[bump-version] version already changed manually (${headVersion} → ${current}); skipping.`);
      process.exit(0);
    }
  } catch {
    /* unreadable HEAD package.json — fall through and bump */
  }
}

const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4]}`;

// Preserve original formatting: replace only the version value.
const updatedPkg = pkgRaw.replace(
  /("version"\s*:\s*")[^"]+(")/,
  (_full, before, after) => `${before}${next}${after}`
);
fs.writeFileSync(pkgPath, updatedPkg);

if (fs.existsSync(versionTsPath)) {
  const tsRaw = fs.readFileSync(versionTsPath, "utf8");
  const updatedTs = tsRaw.replace(
    /(APP_VERSION\s*=\s*")[^"]+(")/,
    (_full, before, after) => `${before}${next}${after}`
  );
  fs.writeFileSync(versionTsPath, updatedTs);
}

// Stage the bump so it lands in the same commit.
if (process.env.BUMP_VERSION_STAGE !== "0") {
  git(["add", "package.json"]);
  if (fs.existsSync(versionTsPath)) git(["add", "src/lib/version.ts"]);
}

console.log(`[bump-version] ${current} → ${next}`);
