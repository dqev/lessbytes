#!/usr/bin/env node
/* ==========================================================================
   lessbytes CLI — compress images from the terminal.
   --------------------------------------------------------------------------
   Usage examples:
     lessbytes photo.jpg                         # smart compress in place-safe mode
     lessbytes *.png -o out/                      # batch into a folder
     lessbytes hero.png --format webp --quality 80
     lessbytes big.jpg --max-size 100kb          # hit a target file size
     lessbytes img.jpg --max-width 1600          # cap dimensions
     lessbytes ./pics --recursive                # walk a directory

   The CLI uses `sharp` (libvips) for fast, high-quality Node-side encoding.
   The browser library stays 100% dependency-free; sharp is an OPTIONAL
   dependency only needed for the CLI. If it's missing we print install help.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* -------------------------- pretty logging -------------------------------- */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m'
};
const supportsColor = process.stdout.isTTY;
function paint(s, c) { return supportsColor ? c + s + C.reset : s; }
function logInfo(s) { console.log(s); }
function logErr(s) { console.error(paint('✖ ' + s, C.red)); }

/* ---------------------------- help text ----------------------------------- */
const HELP = `
${paint('lessbytes', C.bold)} — smart image compressor

${paint('USAGE', C.cyan)}
  lessbytes <files...|dir> [options]

${paint('OPTIONS', C.cyan)}
  -o, --output <path>     Output file or directory (default: alongside source as *.min.*)
  -f, --format <fmt>      auto | jpeg | webp | png | avif        (default: auto)
  -q, --quality <1-100>   Force a quality instead of auto/SSIM search
      --max-size <size>   Target max file size, e.g. 100kb, 1.5mb
      --max-width <px>    Cap output width (keeps aspect ratio)
      --max-height <px>   Cap output height (keeps aspect ratio)
      --ssim <0-1>        Perceptual quality target for auto mode (default: 0.992)
  -r, --recursive         Recurse into directories
      --suffix <str>      Filename suffix for in-place output (default: .min)
      --keep-larger       Write output even if it is bigger than the source
  -s, --silent            Only print errors
  -h, --help              Show this help
  -v, --version           Show version

${paint('EXAMPLES', C.cyan)}
  lessbytes photo.jpg
  lessbytes *.png -o build/img --format webp
  lessbytes hero.png --max-size 80kb
  lessbytes ./assets -r --max-width 1920
`;

/* --------------------------- arg parsing ---------------------------------- */
function parseArgs(argv) {
  const o = {
    inputs: [], output: null, format: 'auto', quality: null, maxSize: null,
    maxWidth: null, maxHeight: null, ssim: 0.992, recursive: false,
    suffix: '.min', keepLarger: false, silent: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-o': case '--output': o.output = next(); break;
      case '-f': case '--format': o.format = String(next()).toLowerCase(); break;
      case '-q': case '--quality': o.quality = parseFloat(next()); break;
      case '--max-size': o.maxSize = parseSize(next()); break;
      case '--max-width': o.maxWidth = parseInt(next(), 10); break;
      case '--max-height': o.maxHeight = parseInt(next(), 10); break;
      case '--ssim': o.ssim = parseFloat(next()); break;
      case '-r': case '--recursive': o.recursive = true; break;
      case '--suffix': o.suffix = next(); break;
      case '--keep-larger': o.keepLarger = true; break;
      case '-s': case '--silent': o.silent = true; break;
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default:
        if (a.startsWith('-')) { throw new Error('Unknown option: ' + a); }
        o.inputs.push(a);
    }
  }
  return o;
}

function parseSize(s) {
  if (!s) return null;
  const m = String(s).trim().toLowerCase().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/);
  if (!m) throw new Error('Invalid size: ' + s);
  const n = parseFloat(m[1]);
  const unit = m[2] || 'b';
  const mult = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }[unit];
  return Math.round(n * mult);
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/* --------------------------- file discovery ------------------------------- */
const IMG_RE = /\.(jpe?g|png|webp|avif|gif|tiff?)$/i;

function expandInputs(inputs, recursive) {
  const files = [];
  inputs.forEach(function (inp) {
    let stat;
    try { stat = fs.statSync(inp); } catch (e) { logErr('Not found: ' + inp); return; }
    if (stat.isDirectory()) {
      walk(inp, recursive, files);
    } else if (IMG_RE.test(inp)) {
      files.push(inp);
    }
  });
  return files;
}

function walk(dir, recursive, out) {
  fs.readdirSync(dir).forEach(function (name) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (recursive) walk(full, recursive, out);
    } else if (IMG_RE.test(name)) {
      out.push(full);
    }
  });
}

/* ----------------------------- sharp loader ------------------------------- */
function loadSharp() {
  try {
    return require('sharp');
  } catch (e) {
    logErr('The lessbytes CLI needs "sharp" for image encoding.');
    console.error(paint('\nInstall it once:', C.yellow));
    console.error('  npm install -g sharp        ' + paint('# if you installed lessbytes globally', C.gray));
    console.error('  npm install sharp           ' + paint('# for a local project', C.gray));
    process.exit(1);
  }
}

/* --------------------- SSIM (luma) for CLI quality gate ------------------- */
// Mirrors the browser core: mean SSIM on luma, computed on a small sample.
function ssimLuma(a, b, w, h) {
  const C1 = 6.5025, C2 = 58.5225, win = 8, stride = 4;
  let total = 0, count = 0;
  for (let y = 0; y + win <= h; y += stride) {
    for (let x = 0; x + win <= w; x += stride) {
      let sA = 0, sB = 0, sAA = 0, sBB = 0, sAB = 0;
      const nWin = win * win;
      for (let wy = 0; wy < win; wy++) {
        const row = (y + wy) * w + x;
        for (let wx = 0; wx < win; wx++) {
          const va = a[row + wx], vb = b[row + wx];
          sA += va; sB += vb; sAA += va * va; sBB += vb * vb; sAB += va * vb;
        }
      }
      const muA = sA / nWin, muB = sB / nWin;
      const vA = sAA / nWin - muA * muA, vB = sBB / nWin - muB * muB;
      const cov = sAB / nWin - muA * muB;
      total += ((2 * muA * muB + C1) * (2 * cov + C2)) /
               ((muA * muA + muB * muB + C1) * (vA + vB + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

async function lumaSample(sharp, buffer, size) {
  const { data, info } = await sharp(buffer)
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { luma: Float64Array.from(data), w: info.width, h: info.height };
}

/* --------------------------- core CLI compress ---------------------------- */
async function compressFile(sharp, file, opts) {
  const srcBuf = fs.readFileSync(file);
  const srcSize = srcBuf.length;
  const meta = await sharp(srcBuf).metadata();

  // Resolve format.
  let fmt = opts.format === 'auto' ? autoFormat(meta) : opts.format;
  if (fmt === 'jpg') fmt = 'jpeg';

  // Build a reusable resized pipeline (dimensions only).
  function pipeline() {
    let p = sharp(srcBuf, { failOn: 'none' }).rotate(); // honor EXIF orientation
    if (opts.maxWidth || opts.maxHeight) {
      p = p.resize({
        width: opts.maxWidth || null,
        height: opts.maxHeight || null,
        fit: 'inside',
        withoutEnlargement: true
      });
    }
    return p;
  }

  function encode(quality) {
    let p = pipeline();
    if (fmt === 'png') return p.png({ compressionLevel: 9, palette: true }).toBuffer();
    if (fmt === 'webp') return p.webp({ quality: Math.round(quality), effort: 5 }).toBuffer();
    if (fmt === 'avif') return p.avif({ quality: Math.round(quality), effort: 4 }).toBuffer();
    return p.jpeg({ quality: Math.round(quality), mozjpeg: true }).toBuffer();
  }

  let outBuf, usedQ, usedSSIM = 1;

  if (fmt === 'png') {
    outBuf = await encode(100);
  } else if (opts.quality != null) {
    outBuf = await encode(opts.quality);
    usedQ = opts.quality;
  } else if (opts.maxSize) {
    ({ outBuf, usedQ } = await searchSize(encode, opts.maxSize));
  } else {
    ({ outBuf, usedQ, usedSSIM } = await searchSSIM(sharp, srcBuf, encode, opts.ssim));
  }

  // Keep original if compression didn't help.
  let keptOriginal = false;
  if (!opts.keepLarger && outBuf.length >= srcSize) {
    outBuf = srcBuf;
    keptOriginal = true;
    fmt = (meta.format === 'jpeg' ? 'jpeg' : meta.format) || fmt;
  }

  const outPath = resolveOutPath(file, fmt, opts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outBuf);

  return {
    file, outPath, srcSize, outSize: outBuf.length, format: fmt,
    quality: usedQ, ssim: usedSSIM, keptOriginal,
    ratio: srcSize ? 1 - outBuf.length / srcSize : 0
  };
}

function autoFormat(meta) {
  // Transparent → webp (keeps alpha, beats png on size). Else webp for photos.
  return 'webp';
}

// Binary search the lowest quality whose SSIM still passes the gate.
async function searchSSIM(sharp, srcBuf, encode, target) {
  const SAMPLE = 320;
  const ref = await lumaSample(sharp, srcBuf, SAMPLE);
  let lo = 40, hi = 96, best = null;
  for (let i = 0; i < 7; i++) {
    const mid = Math.round((lo + hi) / 2);
    const buf = await encode(mid);
    const cmp = await lumaSample(sharp, buf, SAMPLE);
    const score = ssimLuma(ref.luma, cmp.luma, Math.min(ref.w, cmp.w), Math.min(ref.h, cmp.h));
    if (score >= target) { best = { outBuf: buf, usedQ: mid, usedSSIM: score }; hi = mid - 1; }
    else { lo = mid + 1; if (!best) best = { outBuf: buf, usedQ: mid, usedSSIM: score }; }
  }
  return best;
}

// Binary search the highest quality that fits the byte budget.
async function searchSize(encode, budget) {
  let lo = 30, hi = 96, best = null;
  for (let i = 0; i < 8; i++) {
    const mid = Math.round((lo + hi) / 2);
    const buf = await encode(mid);
    if (buf.length <= budget) { best = { outBuf: buf, usedQ: mid }; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (!best) best = { outBuf: await encode(30), usedQ: 30 };
  return best;
}

function resolveOutPath(file, fmt, opts) {
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const base = path.basename(file, path.extname(file));
  if (opts.output) {
    // Directory output if it ends with a separator, has no extension, or exists as a dir.
    const looksDir = opts.output.endsWith('/') || opts.output.endsWith(path.sep) ||
      (fs.existsSync(opts.output) && fs.statSync(opts.output).isDirectory()) ||
      !path.extname(opts.output);
    if (looksDir) return path.join(opts.output, base + '.' + ext);
    return opts.output;
  }
  return path.join(path.dirname(file), base + opts.suffix + '.' + ext);
}

/* -------------------------------- main ------------------------------------ */
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { logErr(e.message); process.exit(1); }

  const pkg = require('../package.json');
  if (opts.version) { console.log(pkg.version); return; }
  if (opts.help || opts.inputs.length === 0) { console.log(HELP); return; }

  const sharp = loadSharp();
  const files = expandInputs(opts.inputs, opts.recursive);
  if (files.length === 0) { logErr('No image files found.'); process.exit(1); }

  if (!opts.silent) {
    logInfo(paint('lessbytes', C.bold) + paint(' v' + pkg.version, C.gray) + '  ' +
      paint('compressing ' + files.length + ' image' + (files.length > 1 ? 's' : ''), C.cyan));
  }

  let totalIn = 0, totalOut = 0, ok = 0, fail = 0;
  for (const file of files) {
    try {
      const r = await compressFile(sharp, file, opts);
      totalIn += r.srcSize; totalOut += r.outSize; ok++;
      if (!opts.silent) printRow(r);
    } catch (e) {
      fail++;
      logErr(path.basename(file) + ' — ' + e.message);
    }
  }

  if (!opts.silent) {
    const saved = totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(1) : '0';
    logInfo('');
    logInfo(paint('Done. ', C.bold) +
      paint(humanSize(totalIn) + ' → ' + humanSize(totalOut), C.cyan) + '  ' +
      paint('(' + saved + '% smaller)', C.green) +
      (fail ? paint('  ' + fail + ' failed', C.red) : ''));
  }
  process.exit(fail && !ok ? 1 : 0);
}

function printRow(r) {
  const name = path.basename(r.file);
  const pct = (r.ratio * 100).toFixed(0);
  const arrow = paint('→', C.gray);
  const sizeStr = humanSize(r.srcSize) + ' ' + arrow + ' ' + humanSize(r.outSize);
  let tag;
  if (r.keptOriginal) tag = paint('kept original', C.yellow);
  else tag = paint('-' + pct + '%', r.ratio > 0 ? C.green : C.yellow) +
    paint('  ' + r.format + (r.quality ? ' q' + r.quality : '') +
      (r.ssim < 1 ? ' ssim ' + r.ssim.toFixed(3) : ''), C.gray);
  logInfo('  ' + paint('✓', C.green) + ' ' + name.padEnd(28).slice(0, 28) + ' ' + sizeStr + '  ' + tag);
}

main().catch(function (e) { logErr(e.message); process.exit(1); });
