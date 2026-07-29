/**
 * tools/package.js
 *
 * Builds the Chrome Web Store upload zip.
 *
 *     node tools/package.js            -> dist/ai-crawlability-lens-<version>.zip
 *
 * The zip contains the extension directory and nothing else. Tests, docs,
 * screenshots, icon concepts and generators are all development artefacts —
 * shipping them inflates the package, and every extra file is another thing a
 * reviewer has to account for.
 *
 * It also refuses to build a package that would fail review for a reason we can
 * detect here, because finding that out a week later in the review queue is the
 * expensive way to learn it.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ai-crawlability-lens');
const DIST = path.join(ROOT, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

/* -------------------------------------------------------------------------- */
/* Pre-flight                                                                  */
/* -------------------------------------------------------------------------- */

const problems = [];
const notes = [];

// Every file the manifest points at must exist. A missing icon is an instant
// rejection and an easy thing to not notice.
for (const [size, rel] of Object.entries(manifest.icons || {})) {
  if (!fs.existsSync(path.join(SRC, rel))) problems.push(`manifest.icons["${size}"] -> missing ${rel}`);
}
for (const [size, rel] of Object.entries((manifest.action && manifest.action.default_icon) || {})) {
  if (!fs.existsSync(path.join(SRC, rel))) problems.push(`action.default_icon["${size}"] -> missing ${rel}`);
}
const popup = manifest.action && manifest.action.default_popup;
if (popup && !fs.existsSync(path.join(SRC, popup))) problems.push(`action.default_popup -> missing ${popup}`);
const sw = manifest.background && manifest.background.service_worker;
if (sw && !fs.existsSync(path.join(SRC, sw))) problems.push(`background.service_worker -> missing ${sw}`);

// Store listings need a description, and it is capped.
if (!manifest.description) problems.push('manifest.description is required');
else if (manifest.description.length > 132) {
  problems.push(`manifest.description is ${manifest.description.length} chars; the Store caps it at 132`);
}

// A statically declared <all_urls> is the single most common cause of a slow or
// failed review. This build asks for host access per-origin at click time, and
// that property is worth defending automatically.
if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length) {
  problems.push(
    `manifest declares static host_permissions (${manifest.host_permissions.join(', ')}). ` +
      'This build requests host access per-origin at click time — a static grant would ' +
      'reintroduce the install-time "read all your data on all websites" warning.'
  );
}

if (!manifest.version || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  problems.push(`manifest.version "${manifest.version}" is not a valid Store version`);
}

// Remote code is a hard rejection. Catch the obvious forms.
const REMOTE = /<script[^>]+src=["']https?:|import\(["']https?:|eval\(/i;
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(full); continue; }
    if (!/\.(js|html)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (REMOTE.test(text)) {
      problems.push(`${path.relative(SRC, full)} appears to load remote code or use eval()`);
    }
  }
})(SRC);

if (!fs.existsSync(path.join(ROOT, 'PRIVACY.md'))) {
  notes.push('PRIVACY.md not found — the Store requires a privacy policy URL when host permissions are used.');
}

if (problems.length) {
  console.error('Refusing to package:\n');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `ai-crawlability-lens-${manifest.version}.zip`);
fs.rmSync(out, { force: true });

// Zip the directory CONTENTS, not the directory itself: Chrome expects
// manifest.json at the root of the archive.
execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '.*', '-x', '__MACOSX/*'], { cwd: SRC });

const bytes = fs.statSync(out).size;
const files = execFileSync('zip', ['-sf', out]).toString().trim().split('\n').length - 2;

console.log(`${path.relative(ROOT, out)}`);
console.log(`  ${files} files, ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  version ${manifest.version}, manifest v${manifest.manifest_version}`);
console.log(`  permissions: ${(manifest.permissions || []).join(', ')}`);
console.log(`  optional host access: ${(manifest.optional_host_permissions || []).join(', ') || 'none'}`);
for (const n of notes) console.log(`  ! ${n}`);
