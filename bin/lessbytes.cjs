#!/usr/bin/env node
/* ==========================================================================
   lessbytes CLI — compress images from the terminal.
   --------------------------------------------------------------------------
   Run with no arguments for a full interactive interface:
     lessbytes

   Or drive it directly:
     lessbytes photo.jpg                         # smart, visually-lossless
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
const readline = require('readline');

/* -------------------------- pretty logging -------------------------------- */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m'
};
const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
function paint(s, c) { return supportsColor ? c + s + C.reset : s; }
function truecolor(r, g, b) { return supportsColor ? `\x1b[38;2;${r};${g};${b}m` : ''; }
function logInfo(s) { console.log(s); }
function logErr(s) { console.error(paint('✖ ' + s, C.red)); }

/* --------------------------- gradient banner ------------------------------ */
// 5-row block glyphs for the letters we need (L E S B Y T).
const GLYPHS = {
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  S: ['█████', '█    ', '█████', '    █', '█████'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  Y: ['█   █', '█   █', ' ███ ', '  █  ', '  █  '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  ']
};

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// Three-stop gradient: purple → blue → teal (matches the brand palette).
function gradientColor(t) {
  const stops = [[108, 92, 231], [9, 132, 227], [0, 184, 148]];
  const seg = t * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - i;
  return [
    lerp(stops[i][0], stops[i + 1][0], f),
    lerp(stops[i][1], stops[i + 1][1], f),
    lerp(stops[i][2], stops[i + 1][2], f)
  ];
}

function gradientText(text, tick) {
  if (!supportsColor) return text;
  let res = '';
  for (let i = 0; i < text.length; i++) {
    const t = ((i / text.length) + (tick * 0.05)) % 1.0;
    const rgb = gradientColor(t);
    res += truecolor(rgb[0], rgb[1], rgb[2]) + text[i];
  }
  return res + C.reset;
}

function printBanner(pkg) {
  const word = 'LESSBYTES';
  const rows = ['', '', '', '', ''];
  for (const ch of word) {
    const g = GLYPHS[ch];
    for (let r = 0; r < 5; r++) rows[r] += g[r] + ' ';
  }
  const width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  logInfo('');
  for (const row of rows) {
    let line = '  ';
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === ' ') { line += ' '; continue; }
      if (!supportsColor) { line += ch; continue; }
      const rgb = gradientColor(i / width);
      line += truecolor(rgb[0], rgb[1], rgb[2]) + ch + C.reset;
    }
    logInfo(line);
  }
  logInfo('  ' + paint('Perceptual image compression — converges on visually lossless', C.gray));
  logInfo('  ' + paint('v' + pkg.version + '  ·  measured, not guessed', C.gray));
}

/* ---------------------------- help text ----------------------------------- */
const HELP = `
${paint('lessbytes', C.bold)} — smart image compressor

${paint('USAGE', C.cyan)}
  lessbytes                       Launch the interactive interface
  lessbytes <files...|dir> [options]

${paint('OPTIONS', C.cyan)}
  -o, --output <path>     Output file or directory (default: alongside source as *.min.*)
  -f, --format <fmt>      auto | jpeg | webp | png | avif        (default: webp)
  -q, --quality <1-100>   Force a quality instead of auto/SSIM search
      --max-size <size>   Target max file size, e.g. 100kb, 1.5mb (downscales if needed)
      --max-width <px>    Cap output width (keeps aspect ratio)
      --max-height <px>   Cap output height (keeps aspect ratio)
      --ssim <0-1>        Perceptual quality target for auto mode (default: 0.992)
  -r, --recursive         Recurse into directories
      --suffix <str>      Filename suffix for in-place output (default: .min)
      --keep-larger       Write output even if it is bigger than the source
  -s, --silent            Only print errors
  -i, --interactive       Force the interactive interface
      --logo              Print only the logo banner and exit
  -h, --help              Show this help
  -v, --version           Show version

${paint('EXAMPLES', C.cyan)}
  lessbytes
  lessbytes photo.jpg
  lessbytes *.png -o build/img --format webp
  lessbytes hero.png --max-size 80kb
  lessbytes ./assets -r --max-width 1920
`;

/* --------------------------- option defaults ------------------------------ */
function defaultOpts() {
  return {
    inputs: [], output: null, format: 'webp', quality: null, maxSize: null,
    maxWidth: null, maxHeight: null, ssim: 0.992, recursive: false,
    suffix: '.min', keepLarger: false, silent: false
  };
}

/* --------------------------- arg parsing ---------------------------------- */
function parseArgs(argv) {
  const o = defaultOpts();
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
      case '-i': case '--interactive': o.interactive = true; break;
      case '--logo': case '--banner': o.logo = true; break;
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

let _avifChecked = false, _avifOk = false;
function avifSupported(sharp) {
  if (_avifChecked) return _avifOk;
  _avifChecked = true;
  try { _avifOk = !!(sharp.format.heif && sharp.format.heif.output.buffer); }
  catch (e) { _avifOk = false; }
  return _avifOk;
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
  const hasAlpha = !!meta.hasAlpha;

  // Base dimensions after applying any explicit caps (never upscales).
  let baseW = meta.width || null;
  let baseH = meta.height || null;
  if (baseW && opts.maxWidth && baseW > opts.maxWidth) {
    baseH = baseH ? Math.round(baseH * opts.maxWidth / baseW) : null;
    baseW = opts.maxWidth;
  }
  if (baseH && opts.maxHeight && baseH > opts.maxHeight) {
    baseW = baseW ? Math.round(baseW * opts.maxHeight / baseH) : null;
    baseH = opts.maxHeight;
  }

  // Returns an encoder bound to a specific output format.
  function makeEncoder(fmt) {
    return function encode(quality, scale) {
      scale = scale || 1;
      let p = sharp(srcBuf, { failOn: 'none' }).rotate(); // honor EXIF orientation
      const w = baseW ? Math.max(1, Math.round(baseW * scale)) : null;
      const h = baseH ? Math.max(1, Math.round(baseH * scale)) : null;
      if (w || h) p = p.resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true });
      const q = Math.max(1, Math.min(100, Math.round(quality)));
      if (fmt === 'png') return p.png({ compressionLevel: 9, palette: true, quality: q }).toBuffer();
      if (fmt === 'webp') return p.webp({ quality: q, effort: 5 }).toBuffer();
      if (fmt === 'avif') return p.avif({ quality: q, effort: 4 }).toBuffer();
      if (hasAlpha) p = p.flatten({ background: opts.background || '#ffffff' });
      return p.jpeg({ quality: q, mozjpeg: true }).toBuffer();
    };
  }

  // Produce a single format's best result under the active mode.
  async function produceFormat(fmt) {
    const encode = makeEncoder(fmt);
    if (opts.quality != null) {
      const buf = await encode(opts.quality);
      return { fmt, outBuf: buf, usedQ: opts.quality, usedSSIM: null, scale: 1 };
    }
    if (opts.maxSize) {
      const r = await searchSize(encode, opts.maxSize, baseW);
      return { fmt, outBuf: r.outBuf, usedQ: r.usedQ, usedSSIM: null, scale: r.scale };
    }
    const r = await searchSSIM(sharp, srcBuf, encode, opts.ssim);
    return { fmt, outBuf: r.outBuf, usedQ: r.usedQ, usedSSIM: r.usedSSIM, scale: 1 };
  }

  // Decide which formats to try.
  let candidates;
  if (opts.format === 'auto') {
    candidates = hasAlpha ? ['webp', 'avif', 'png'] : ['webp', 'avif', 'jpeg'];
  } else {
    candidates = [opts.format === 'jpg' ? 'jpeg' : opts.format];
  }
  candidates = candidates.filter(function (f) { return f !== 'avif' || avifSupported(sharp); });

  // Encode every candidate; keep the smallest that succeeds.
  const results = [];
  for (const fmt of candidates) {
    try { results.push(await produceFormat(fmt)); }
    catch (e) { /* skip a format the local encoder can't produce */ }
  }
  if (!results.length) throw new Error('no encoder could produce output');
  results.sort(function (a, b) { return a.outBuf.length - b.outBuf.length; });

  let chosen = results[0];
  let outBuf = chosen.outBuf;
  let fmt = chosen.fmt;

  // Keep the original if compression didn't actually help.
  let keptOriginal = false;
  if (!opts.keepLarger && outBuf.length >= srcSize) {
    outBuf = srcBuf;
    keptOriginal = true;
    fmt = meta.format || fmt;
  }

  const overBudget = !keptOriginal && opts.maxSize != null && outBuf.length > opts.maxSize;

  const outPath = resolveOutPath(file, fmt, opts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outBuf);

  return {
    file, outPath, srcSize, outSize: outBuf.length, format: fmt,
    quality: keptOriginal ? null : chosen.usedQ,
    ssim: keptOriginal ? null : chosen.usedSSIM,
    scale: keptOriginal ? 1 : chosen.scale,
    keptOriginal, overBudget,
    ratio: srcSize ? 1 - outBuf.length / srcSize : 0
  };
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

// Hit a byte budget: search quality first, then progressively downscale
// dimensions when even the lowest quality at full size overshoots.
async function searchSize(encode, budget, baseW) {
  let best = null;
  let scale = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    let lo = 20, hi = 96, localBest = null;
    for (let i = 0; i < 8; i++) {
      const mid = Math.round((lo + hi) / 2);
      const buf = await encode(mid, scale);
      if (buf.length <= budget) { localBest = { outBuf: buf, usedQ: mid, scale }; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (localBest) return localBest;

    // Even q20 at this scale is over budget — remember it and shrink.
    const lowBuf = await encode(20, scale);
    if (!best || lowBuf.length < best.outBuf.length) best = { outBuf: lowBuf, usedQ: 20, scale };
    if (lowBuf.length <= budget) return best;
    scale *= 0.8;
    if (baseW && Math.round(baseW * scale) < 16) break;
  }
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

/* --------------------------- result printing ------------------------------ */
function printRow(r) {
  const name = path.basename(r.file);
  const pct = r.ratio >= 1 ? '100' : String(Math.min(99, Math.round(r.ratio * 100)));
  const arrow = paint('→', C.gray);
  const sizeStr = humanSize(r.srcSize) + ' ' + arrow + ' ' + humanSize(r.outSize);
  let tag;
  if (r.keptOriginal) {
    tag = paint('kept original', C.yellow);
  } else {
    const meta = [];
    meta.push(r.format);
    if (r.quality != null) meta.push('q' + Math.round(r.quality));
    if (r.ssim != null && r.ssim < 1) meta.push('ssim ' + r.ssim.toFixed(3));
    if (r.scale && r.scale < 0.999) meta.push((r.scale * 100).toFixed(0) + '% scale');
    tag = paint('-' + pct + '%', r.ratio > 0 ? C.green : C.yellow) +
      paint('  ' + meta.join(' '), C.gray);
    if (r.overBudget) tag += paint('  ⚠ over target', C.yellow);
  }
  logInfo('  ' + paint('✓', C.green) + ' ' + name.padEnd(28).slice(0, 28) + ' ' + sizeStr + '  ' + tag);
}

/* --------------------------- run compression ------------------------------ */
async function runCompression(opts, pkg) {
  const sharp = loadSharp();
  const files = expandInputs(opts.inputs, opts.recursive);
  if (files.length === 0) { logErr('No image files found.'); process.exit(1); }

  if (!opts.silent) {
    logInfo('');
    logInfo(paint('lessbytes', C.bold) + paint(' v' + pkg.version, C.gray) + '  ' +
      paint('compressing ' + files.length + ' image' + (files.length > 1 ? 's' : ''), C.cyan));
  }

  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let totalIn = 0, totalOut = 0, ok = 0, fail = 0;
  for (const file of files) {
    let spinnerInterval = null;
    if (!opts.silent && process.stdout.isTTY) {
      let spinnerTick = 0;
      const statusText = `compressing ${path.basename(file)}...`;
      
      const updateSpinner = (tick) => {
        const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
        const rgb = gradientColor((tick % 20) / 20);
        const coloredSpinner = truecolor(rgb[0], rgb[1], rgb[2]) + frame + C.reset;
        const coloredStatus = gradientText(statusText, tick);
        process.stdout.write(`\r  ${coloredSpinner} ${coloredStatus}`);
      };

      // Print first frame immediately
      updateSpinner(0);

      spinnerInterval = setInterval(() => {
        spinnerTick++;
        updateSpinner(spinnerTick);
      }, 80);
    } else if (!opts.silent) {
      logInfo(`  compressing ${path.basename(file)}...`);
    }

    try {
      const r = await compressFile(sharp, file, opts);
      totalIn += r.srcSize; totalOut += r.outSize; ok++;
      if (spinnerInterval) {
        clearInterval(spinnerInterval);
        process.stdout.write('\r\x1b[K');
      }
      if (!opts.silent) printRow(r);
    } catch (e) {
      fail++;
      if (spinnerInterval) {
        clearInterval(spinnerInterval);
        process.stdout.write('\r\x1b[K');
      }
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
  return fail && !ok ? 1 : 0;
}

/* --------------------------- interactive mode ----------------------------- */
// A small line reader that buffers incoming lines into a queue so no input is
// dropped between prompts (rl.question loses buffered lines on piped stdin).
function makeReader() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', function (line) {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', function () {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    next: function () {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise(function (res) { waiters.push(res); });
    },
    close: function () { rl.close(); }
  };
}

async function ask(reader, prompt) {
  process.stdout.write(prompt);
  const line = await reader.next();
  return line == null ? null : String(line).trim();
}

async function choose(reader, title, options, defIndex) {
  logInfo('');
  logInfo('  ' + paint(title, C.bold));
  options.forEach(function (o, i) {
    const def = i === defIndex ? paint('  (default)', C.gray) : '';
    logInfo('    ' + paint(String(i + 1), C.cyan) + '  ' + o[1] + def);
  });
  const ans = await ask(reader, paint('  › ', C.gray));
  if (!ans) return options[defIndex][0];
  const n = parseInt(ans, 10);
  if (n >= 1 && n <= options.length) return options[n - 1][0];
  return options[defIndex][0];
}

function stripQuotes(s) { return (s || '').replace(/^['"]|['"]$/g, ''); }

async function runInteractive(pkg) {
  printBanner(pkg);
  const reader = makeReader();
  try {
    // Input path.
    let inputPath;
    while (true) {
      const ans = await ask(reader, '\n  ' + paint('Image file or folder', C.bold) + paint(' › ', C.gray));
      if (ans == null) { logErr('No input provided.'); reader.close(); process.exitCode = 1; return; }
      inputPath = stripQuotes(ans);
      if (!inputPath) { logErr('Please enter a path.'); continue; }
      if (fs.existsSync(inputPath)) break;
      logErr('Not found: ' + inputPath);
    }
    const isDir = fs.statSync(inputPath).isDirectory();

    // Format.
    const format = await choose(reader, 'Output format', [
      ['webp', 'WebP'],
      ['auto', 'Auto — compete AVIF / WebP / JPEG, keep the smallest'],
      ['avif', 'AVIF'],
      ['jpeg', 'JPEG'],
      ['png', 'PNG']
    ], 0);

    // Mode.
    const mode = await choose(reader, 'Compression mode', [
      ['smart', 'Smart — visually lossless (SSIM-guided search)'],
      ['size', 'Target file size'],
      ['quality', 'Fixed quality']
    ], 0);

    const opts = defaultOpts();
    opts.format = format;
    opts.inputs = [inputPath];

    if (mode === 'size') {
      while (true) {
        const raw = await ask(reader, '\n  ' + paint('Target max size', C.bold) + paint(' (e.g. 100kb, 1.5mb) › ', C.gray));
        try { opts.maxSize = parseSize(raw); if (opts.maxSize) break; } catch (e) { /* retry */ }
        logErr('Enter a size like 100kb or 1.5mb.');
      }
    } else if (mode === 'quality') {
      while (true) {
        const raw = await ask(reader, '\n  ' + paint('Quality', C.bold) + paint(' (1-100) › ', C.gray));
        const q = parseFloat(raw);
        if (q >= 1 && q <= 100) { opts.quality = q; break; }
        logErr('Enter a number between 1 and 100.');
      }
    } else {
      const raw = await ask(reader, '\n  ' + paint('SSIM target', C.bold) + paint(' (blank = 0.992) › ', C.gray));
      const s = parseFloat(raw);
      if (s > 0 && s <= 1) opts.ssim = s;
    }

    // Optional max width.
    const mw = await ask(reader, '\n  ' + paint('Max width in px', C.bold) + paint(' (blank = no limit) › ', C.gray));
    if (mw && parseInt(mw, 10) > 0) opts.maxWidth = parseInt(mw, 10);

    // Output path.
    const out = stripQuotes(await ask(reader, '\n  ' + paint('Output path', C.bold) + paint(' (blank = beside source) › ', C.gray)));
    if (out) opts.output = out;

    // Recursive for directories.
    if (isDir) {
      const r = await ask(reader, '\n  ' + paint('Recurse into subfolders?', C.bold) + paint(' (y/N) › ', C.gray));
      opts.recursive = /^y/i.test(r || '');
    }

    reader.close();
    const code = await runCompression(opts, pkg);
    process.exitCode = code;
  } catch (e) {
    reader.close();
    logErr(e.message);
    process.exitCode = 1;
  }
}

/* -------------------------------- main ------------------------------------ */
async function main() {
  const isNpx = process.env.npm_lifecycle_event === 'npx' ||
                process.env.npm_command === 'exec' ||
                /\b_npx\b/.test(__filename);

  if (isNpx) {
    logErr('lessbytes must be installed globally to run.');
    console.error(paint('\nPlease install it globally using:', C.yellow));
    console.error('  npm install -g lessbytes');
    console.error(paint('\nAnd then run it directly:', C.yellow));
    console.error('  lessbytes\n');
    process.exit(1);
  }

  const pkg = require('../package.json');
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { logErr(e.message); process.exit(1); }

  if (opts.version) { console.log(pkg.version); return; }
  if (opts.logo) { printBanner(pkg); console.log(''); return; }
  if (opts.help) { console.log(HELP); return; }

  if (opts.inputs.length === 0) {
    if (opts.interactive || process.stdin.isTTY) { await runInteractive(pkg); return; }
    console.log(HELP);
    return;
  }

  const code = await runCompression(opts, pkg);
  process.exit(code);
}

main().catch(function (e) { logErr(e.message); process.exit(1); });
