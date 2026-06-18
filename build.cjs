/* eslint-disable */
/* ==========================================================================
   BUILD — wraps src/compressor.core.js into distributable bundles:
     dist/lessbytes.umd.js       (unpkg / <script> global: lessbytes)
     dist/lessbytes.umd.min.js   (lightweight minify)
     dist/lessbytes.esm.js       (import { compress } from 'lessbytes')
   No external dependencies — pure Node fs.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const core = fs.readFileSync(path.join(root, 'src', 'compressor.core.js'), 'utf8');

const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

const banner = `/*!
 * lessbytes v1.0.0
 * Perceptual (SSIM-guided) image compressor for the browser. MIT License.
 * https://github.com/dqev/lessbytes
 */`;

/* ---------- UMD (global + CommonJS + AMD) ---------- */
const umd = `${banner}
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.lessbytes = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
${core}
  return PUBLIC_API;
}));
`;

/* ---------- ESM (named + default exports) ---------- */
const esm = `${banner}
'use strict';
${core}
export { compress, compressBatch, computeSSIM, isFormatSupported, VERSION as version, DEFAULTS as defaults };
export default PUBLIC_API;
`;

/* ---------- tiny, safe minifier (comments + dead whitespace only) ---------- */
function lightMinify(src) {
  return src
    // strip block comments (keep the leading banner separately)
    .replace(/\/\*[^!][\s\S]*?\*\//g, '')
    // strip line comments that occupy their own line
    .replace(/^\s*\/\/.*$/gm, '')
    // collapse blank lines
    .replace(/\n\s*\n+/g, '\n')
    // trim trailing whitespace
    .replace(/[ \t]+$/gm, '');
}

fs.writeFileSync(path.join(distDir, 'lessbytes.umd.cjs'), umd, 'utf8');
fs.writeFileSync(path.join(distDir, 'lessbytes.umd.min.js'), banner + '\n' + lightMinify(umd), 'utf8');
fs.writeFileSync(path.join(distDir, 'lessbytes.esm.js'), esm, 'utf8');

/* ---------- copy hand-written type definitions from src → dist ---------- */
fs.copyFileSync(path.join(root, 'src', 'index.d.ts'), path.join(distDir, 'index.d.ts'));

const sizes = fs.readdirSync(distDir).map(f => {
  const bytes = fs.statSync(path.join(distDir, f)).size;
  return `  ${f}  —  ${(bytes / 1024).toFixed(1)} KB`;
});
console.log('Built lessbytes:\n' + sizes.join('\n'));
