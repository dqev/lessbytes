/* ==========================================================================
   lessbytes — CORE
   --------------------------------------------------------------------------
   A dependency-free, perceptual-quality-aware image compressor for the
   browser. It finds the smallest possible file that still looks the same to
   the human eye by:
     1. Detecting real transparency at the pixel level.
     2. Competing multiple modern formats (AVIF / WebP / JPEG) in `auto` mode
        and keeping the smallest encode that passes a perceptual SSIM gate.
     3. Running an SSIM-guided binary search over encoder quality.
     4. Optional high-quality stepped downscaling + a target-file-size mode.

   This file contains ONLY the implementation (no module wrapper). The build
   step (build.js) wraps it into UMD + ESM distributions. The public API
   surface is the set of functions listed in `PUBLIC_API` at the bottom.
   ========================================================================== */

var VERSION = '1.0.0';

/* --------------------------------------------------------------------------
   ENVIRONMENT / FORMAT SUPPORT
   -------------------------------------------------------------------------- */

var _supportCache = {};

/**
 * Detects whether the current browser can ENCODE a given mime type via canvas.
 * @param {string} mime e.g. "image/webp"
 * @returns {boolean}
 */
function isFormatSupported(mime) {
  if (mime in _supportCache) return _supportCache[mime];
  var supported = false;
  try {
    var c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    // toDataURL echoes back the requested mime only if encoding is supported.
    var data = c.toDataURL(mime);
    supported = data.indexOf('data:' + mime) === 0;
  } catch (e) {
    supported = false;
  }
  _supportCache[mime] = supported;
  return supported;
}

var FORMAT_MIME = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  png: 'image/png',
  avif: 'image/avif'
};

function normalizeFormat(fmt) {
  if (!fmt) return 'jpeg';
  fmt = String(fmt).toLowerCase();
  if (fmt === 'jpg') return 'jpeg';
  return fmt;
}

/* --------------------------------------------------------------------------
   DEFAULTS
   -------------------------------------------------------------------------- */

var DEFAULTS = {
  // 'auto' competes AVIF/WebP/JPEG (and PNG when transparent) and keeps the
  // smallest encode that still passes the perceptual SSIM gate. You can also
  // force a single format: 'jpeg' | 'webp' | 'png' | 'avif'.
  format: 'auto',
  // Candidate formats tried in 'auto' mode, best-compression-first.
  autoCandidates: ['avif', 'webp', 'jpeg'],
  // Target perceptual quality (SSIM). 0.992 ≈ visually lossless for photos.
  targetSSIM: 0.992,
  // Hard bounds for the encoder quality search.
  minQuality: 0.4,
  maxQuality: 0.96,
  // Binary-search iterations. 7 ≈ <1% quality resolution.
  searchSteps: 7,
  // Optional pixel caps. null = keep original dimensions.
  maxWidth: null,
  maxHeight: null,
  // Optional hard file-size budget in bytes. Overrides SSIM mode when set.
  targetSize: null,
  // Background fill used when flattening transparency into a lossy format.
  background: '#ffffff',
  // Cap used for the SSIM computation to keep it fast on huge images.
  ssimSampleSize: 320,
  // If the compressed result is not smaller than the source, return original.
  keepSmallest: true
};

function assign(target) {
  for (var i = 1; i < arguments.length; i++) {
    var src = arguments[i];
    if (!src) continue;
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) {
        target[k] = src[k];
      }
    }
  }
  return target;
}

/* --------------------------------------------------------------------------
   DECODING
   -------------------------------------------------------------------------- */

/**
 * Loads any Blob/File/HTMLImageElement/URL into a drawable bitmap source.
 * @returns {Promise<{img: CanvasImageSource, width:number, height:number, hasAlpha:boolean, type:string, size:number}>}
 */
function decode(input) {
  return new Promise(function (resolve, reject) {
    // Already an <img>?
    if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
      resolve({
        img: input,
        width: input.naturalWidth,
        height: input.naturalHeight,
        hasAlpha: false,
        type: 'image/*',
        size: 0
      });
      return;
    }

    var blob = input;
    var isBlob = (typeof Blob !== 'undefined' && input instanceof Blob);
    if (!isBlob && typeof input === 'string') {
      // Treat as URL — fetch then decode.
      fetch(input)
        .then(function (r) { return r.blob(); })
        .then(function (b) { return decode(b); })
        .then(resolve)
        .catch(reject);
      return;
    }
    if (!isBlob) {
      reject(new TypeError('lessbytes: unsupported input type'));
      return;
    }

    var type = blob.type || 'image/*';
    var size = blob.size || 0;
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      URL.revokeObjectURL(url);
      // Only formats that *can* carry alpha are worth scanning.
      var maybeAlpha = /png|webp|gif|avif/i.test(type);
      resolve({
        img: img,
        width: w,
        height: h,
        hasAlpha: maybeAlpha ? detectAlpha(img, w, h) : false,
        type: type,
        size: size
      });
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error('lessbytes: failed to decode image'));
    };
    img.src = url;
  });
}

/**
 * Detects real transparency by scanning a downsampled copy for any pixel whose
 * alpha is below 250. Cheap (max 64x64) and far more accurate than trusting
 * the source mime type.
 */
function detectAlpha(img, w, h) {
  try {
    var s = fitDimensions(w, h, 64, 64);
    var cv = makeCanvas(s.width, s.height);
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, s.width, s.height);
    var data = ctx.getImageData(0, 0, s.width, s.height).data;
    for (var i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
  } catch (e) {
    // Tainted canvas or other failure — assume alpha to be safe.
    return true;
  }
  return false;
}

/* --------------------------------------------------------------------------
   CANVAS HELPERS + HIGH-QUALITY DOWNSCALING
   -------------------------------------------------------------------------- */

function makeCanvas(w, h) {
  var c;
  if (typeof OffscreenCanvas !== 'undefined') {
    c = new OffscreenCanvas(w, h);
  } else {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
  }
  return c;
}

/**
 * Computes target dimensions honoring maxWidth/maxHeight while preserving
 * aspect ratio. Never upscales.
 */
function fitDimensions(w, h, maxW, maxH) {
  var scale = 1;
  if (maxW && w > maxW) scale = Math.min(scale, maxW / w);
  if (maxH && h > maxH) scale = Math.min(scale, maxH / h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scaled: scale < 1
  };
}

/**
 * Draws `source` into a canvas at the requested size. When downscaling by more
 * than 2x, it halves repeatedly first — this preserves far more detail than a
 * single bilinear pass (the classic "step down" technique).
 */
function drawScaled(source, srcW, srcH, dstW, dstH, background, flatten) {
  var current = source;
  var curW = srcW;
  var curH = srcH;

  // Stepped halving while the gap to target is > 2x.
  while (curW / 2 >= dstW && curH / 2 >= dstH && (curW > dstW || curH > dstH)) {
    var halfW = Math.max(dstW, Math.floor(curW / 2));
    var halfH = Math.max(dstH, Math.floor(curH / 2));
    var tmp = makeCanvas(halfW, halfH);
    var tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(current, 0, 0, halfW, halfH);
    current = tmp;
    curW = halfW;
    curH = halfH;
  }

  var canvas = makeCanvas(dstW, dstH);
  var ctx = canvas.getContext('2d');
  if (flatten) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, dstW, dstH);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, dstW, dstH);
  return canvas;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise(function (resolve, reject) {
    if (canvas.convertToBlob) {
      // OffscreenCanvas path.
      canvas.convertToBlob({ type: mime, quality: quality })
        .then(resolve)
        .catch(reject);
      return;
    }
    canvas.toBlob(function (blob) {
      if (blob) resolve(blob);
      else reject(new Error('lessbytes: encoding failed for ' + mime));
    }, mime, quality);
  });
}

function getImageData(canvas) {
  var ctx = canvas.getContext('2d');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/* --------------------------------------------------------------------------
   SSIM — PERCEPTUAL QUALITY METRIC
   --------------------------------------------------------------------------
   Mean SSIM over an 8x8 sliding window on the luma (grayscale) channel.
   Both images are first resampled to a small common size (ssimSampleSize) so
   the metric is fast and resolution-independent.
   -------------------------------------------------------------------------- */

function toLumaArray(imageData) {
  var d = imageData.data;
  var n = d.length / 4;
  var luma = new Float64Array(n);
  for (var i = 0, j = 0; i < d.length; i += 4, j++) {
    // Rec. 601 luma.
    luma[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  return luma;
}

/**
 * Computes mean SSIM between two equal-sized luma buffers.
 * @returns {number} 0..1 (1 == identical)
 */
function ssim(lumaA, lumaB, width, height) {
  var C1 = 6.5025;   // (0.01 * 255)^2
  var C2 = 58.5225;  // (0.03 * 255)^2
  var win = 8;
  var stride = 4; // step the window by 4px for speed
  var total = 0;
  var count = 0;

  for (var y = 0; y + win <= height; y += stride) {
    for (var x = 0; x + win <= width; x += stride) {
      var sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      var nWin = win * win;
      for (var wy = 0; wy < win; wy++) {
        var row = (y + wy) * width + x;
        for (var wx = 0; wx < win; wx++) {
          var a = lumaA[row + wx];
          var b = lumaB[row + wx];
          sumA += a;
          sumB += b;
          sumAA += a * a;
          sumBB += b * b;
          sumAB += a * b;
        }
      }
      var muA = sumA / nWin;
      var muB = sumB / nWin;
      var varA = sumAA / nWin - muA * muA;
      var varB = sumBB / nWin - muB * muB;
      var covAB = sumAB / nWin - muA * muB;

      var num = (2 * muA * muB + C1) * (2 * covAB + C2);
      var den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
      total += num / den;
      count++;
    }
  }
  return count ? total / count : 1;
}

/**
 * Public: compute SSIM between two canvases/ImageData of equal size.
 */
function computeSSIM(refData, cmpData) {
  if (refData.width !== cmpData.width || refData.height !== cmpData.height) {
    throw new Error('lessbytes: SSIM requires equal dimensions');
  }
  var la = toLumaArray(refData);
  var lb = toLumaArray(cmpData);
  return ssim(la, lb, refData.width, refData.height);
}

/* --------------------------------------------------------------------------
   FORMAT SELECTION
   -------------------------------------------------------------------------- */

/**
 * Returns the ordered list of formats to actually try.
 *  - explicit format → just that one
 *  - 'auto' → the supported subset of autoCandidates, plus PNG when the image
 *    is transparent (so transparency can survive if no lossy format wins)
 */
function resolveCandidates(opts, hasAlpha) {
  var requested = normalizeFormat(opts.format);
  if (requested !== 'auto') return [requested];

  var list = [];
  (opts.autoCandidates || ['webp', 'jpeg']).forEach(function (f) {
    f = normalizeFormat(f);
    var mime = FORMAT_MIME[f];
    // In Node (no document), isFormatSupported can't probe — assume supported
    // and let the encoder reject unavailable formats gracefully.
    var canEncode = (typeof document === 'undefined') ? true : isFormatSupported(mime);
    if (canEncode && list.indexOf(f) === -1) list.push(f);
  });
  // Transparent sources: keep PNG as a lossless fallback that preserves alpha.
  if (hasAlpha && list.indexOf('png') === -1) list.push('png');
  // Absolute fallback.
  if (!list.length) list.push('jpeg');
  return list;
}

function isLossy(format) {
  return format === 'jpeg' || format === 'webp' || format === 'avif';
}

/* --------------------------------------------------------------------------
   CORE COMPRESSION
   -------------------------------------------------------------------------- */

/**
 * Compress a single image.
 * @param {Blob|File|HTMLImageElement|string} input
 * @param {object} [options]
 * @returns {Promise<{blob:Blob, width:number, height:number, format:string,
 *   quality:number, ssim:number, originalSize:number, size:number,
 *   ratio:number, dataURL:Promise<string>}>}
 */
function compress(input, options) {
  var opts = assign({}, DEFAULTS, options);

  return decode(input).then(function (decoded) {
    var originalSize = decoded.size || (input && input.size) || 0;
    var candidates = resolveCandidates(opts, decoded.hasAlpha);

    // Resolve output dimensions once (shared across all candidate formats).
    var fit = fitDimensions(decoded.width, decoded.height, opts.maxWidth, opts.maxHeight);

    // Run each candidate format, then keep the smallest result. PNG is only
    // ever chosen if it genuinely beats the lossy encodes on size.
    var idx = 0;
    var winner = null;

    function tryNext() {
      if (idx >= candidates.length) return Promise.resolve(winner);
      var format = candidates[idx++];
      return compressOne(input, decoded, fit, format, originalSize, opts)
        .then(function (res) {
          if (res && (!winner || res.size < winner.size)) winner = res;
          return tryNext();
        })
        .catch(function () {
          // Skip a format the browser/encoder can't actually produce.
          return tryNext();
        });
    }

    return tryNext().then(function (res) {
      if (!res) throw new Error('lessbytes: no format could be encoded');
      return res;
    });
  });
}

/**
 * Compress the image into a SINGLE specified format and return its result.
 */
function compressOne(input, decoded, fit, format, originalSize, opts) {
  var mime = FORMAT_MIME[format] || 'image/jpeg';
  var flatten = isLossy(format); // lossy formats can't carry alpha → flatten

  var baseCanvas = drawScaled(
    decoded.img, decoded.width, decoded.height,
    fit.width, fit.height, opts.background, flatten
  );

  // PNG is lossless — quality arg is ignored, just encode once.
  if (format === 'png') {
    return canvasToBlob(baseCanvas, mime, 1).then(function (blob) {
      return finalize(input, blob, baseCanvas, format, 1, 1, originalSize, opts);
    });
  }

  // Reference luma for SSIM, computed on a small common sample size.
  var sample = fitDimensions(fit.width, fit.height, opts.ssimSampleSize, opts.ssimSampleSize);
  var refSampleCanvas = drawScaled(baseCanvas, fit.width, fit.height, sample.width, sample.height, opts.background, false);
  var refLuma = toLumaArray(getImageData(refSampleCanvas));

  if (opts.targetSize) {
    return searchByTargetSize(input, baseCanvas, fit, sample, refLuma, mime, format, originalSize, opts);
  }
  return searchBySSIM(input, baseCanvas, fit, sample, refLuma, mime, format, originalSize, opts);
}

/**
 * SSIM-guided binary search: find the LOWEST quality whose SSIM still meets
 * the target. Lower quality = smaller file, so the lowest passing quality is
 * the smallest file that still looks right.
 */
function searchBySSIM(input, baseCanvas, fit, sample, refLuma, mime, format, originalSize, opts) {
  var lo = opts.minQuality;
  var hi = opts.maxQuality;
  var best = null;

  function measure(q) {
    return canvasToBlob(baseCanvas, mime, q).then(function (blob) {
      // Measure SSIM of the ENCODED result by decoding the blob back and
      // comparing its luma against the reference at the sample size.
      return blobToSampleLuma(blob, sample, opts).then(function (cmpLuma) {
        var score = ssim(refLuma, cmpLuma, sample.width, sample.height);
        return { quality: q, blob: blob, ssim: score };
      });
    });
  }

  var step = function (iter) {
    if (iter <= 0) return Promise.resolve();
    var mid = (lo + hi) / 2;
    return measure(mid).then(function (res) {
      if (res.ssim >= opts.targetSSIM) {
        // Quality is high enough — try to go smaller.
        best = res;
        hi = mid;
      } else {
        // Too lossy — need more quality.
        lo = mid;
        if (!best) best = res; // keep something in case nothing passes
      }
      return step(iter - 1);
    });
  };

  return step(opts.searchSteps).then(function () {
    // Guarantee we have an encode at the final hi bound.
    return measure(hi).then(function (res) {
      if (!best || res.ssim >= opts.targetSSIM) best = res;
      return finalize(input, best.blob, baseCanvas, format, best.quality, best.ssim, originalSize, opts);
    });
  });
}

/**
 * Target-size mode: binary search quality to fit within a byte budget. If even
 * the minimum quality overshoots, progressively downscale the canvas.
 */
function searchByTargetSize(input, baseCanvas, fit, sample, refLuma, mime, format, originalSize, opts) {
  var budget = opts.targetSize;
  var canvas = baseCanvas;
  var curW = fit.width;
  var curH = fit.height;

  function searchQuality(cv, w, h) {
    var lo = opts.minQuality;
    var hi = opts.maxQuality;
    var best = null;
    var step = function (iter) {
      if (iter <= 0) return Promise.resolve();
      var mid = (lo + hi) / 2;
      return canvasToBlob(cv, mime, mid).then(function (blob) {
        if (blob.size <= budget) {
          best = { quality: mid, blob: blob };
          lo = mid; // can we afford more quality?
        } else {
          hi = mid;
        }
        return step(iter - 1);
      });
    };
    return step(opts.searchSteps).then(function () { return best; });
  }

  function attempt(cv, w, h, downscales) {
    return searchQuality(cv, w, h).then(function (best) {
      if (best) return best;
      if (downscales <= 0) {
        // Give up shrinking; return the smallest possible (min quality).
        return canvasToBlob(cv, mime, opts.minQuality).then(function (blob) {
          return { quality: opts.minQuality, blob: blob };
        });
      }
      // Downscale 15% and retry.
      var nw = Math.max(1, Math.round(w * 0.85));
      var nh = Math.max(1, Math.round(h * 0.85));
      var next = drawScaled(cv, w, h, nw, nh, opts.background, isLossy(format));
      return attempt(next, nw, nh, downscales - 1);
    });
  }

  return attempt(canvas, curW, curH, 8).then(function (best) {
    return blobToSampleLuma(best.blob, sample, opts).then(function (cmpLuma) {
      var score = ssim(refLuma, cmpLuma, sample.width, sample.height);
      return finalize(input, best.blob, baseCanvas, format, best.quality, score, originalSize, opts);
    });
  });
}

// Helper: decode an encoded blob and return its luma at the SSIM sample size.
function blobToSampleLuma(blob, sample, opts) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var cv = drawScaled(img, img.naturalWidth, img.naturalHeight, sample.width, sample.height, opts.background, false);
      URL.revokeObjectURL(url);
      resolve(toLumaArray(getImageData(cv)));
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('lessbytes: re-decode failed')); };
    img.src = url;
  });
}

// Placeholder kept for clarity in searchBySSIM (baseCanvas reused directly).
function baseCanvasFromBlobPlaceholder(baseCanvas) {
  return baseCanvas;
}

/**
 * Assemble the public result object, honoring keepSmallest.
 */
function finalize(input, blob, canvas, format, quality, ssimScore, originalSize, opts) {
  var size = blob.size;
  var useOriginal = false;

  if (opts.keepSmallest && originalSize > 0 && size >= originalSize && (typeof Blob !== 'undefined' && input instanceof Blob)) {
    useOriginal = true;
  }

  var outBlob = useOriginal ? input : blob;
  var outSize = outBlob.size;

  return {
    blob: outBlob,
    width: canvas.width,
    height: canvas.height,
    format: useOriginal ? (input.type || format) : format,
    quality: useOriginal ? 1 : Math.round(quality * 100) / 100,
    ssim: Math.round(ssimScore * 10000) / 10000,
    originalSize: originalSize,
    size: outSize,
    ratio: originalSize ? Math.round((1 - outSize / originalSize) * 1000) / 1000 : 0,
    keptOriginal: useOriginal,
    toDataURL: function () { return blobToDataURL(outBlob); },
    toFile: function (name) {
      var ext = (useOriginal ? (input.type || '').split('/')[1] : format) || 'jpg';
      var fname = name || ('compressed.' + (ext === 'jpeg' ? 'jpg' : ext));
      try {
        return new File([outBlob], fname, { type: outBlob.type });
      } catch (e) {
        return outBlob; // File ctor unavailable
      }
    }
  };
}

function blobToDataURL(blob) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(fr.result); };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/**
 * Compress many images with bounded concurrency.
 * @param {Array} inputs
 * @param {object} [options] — may include `concurrency` (default 3) and
 *   `onProgress(done, total, lastResult)`.
 */
function compressBatch(inputs, options) {
  options = options || {};
  var concurrency = options.concurrency || 3;
  var onProgress = options.onProgress;
  var results = new Array(inputs.length);
  var index = 0;
  var done = 0;

  function worker() {
    if (index >= inputs.length) return Promise.resolve();
    var i = index++;
    return compress(inputs[i], options).then(function (res) {
      results[i] = res;
      done++;
      if (onProgress) onProgress(done, inputs.length, res);
      return worker();
    }).catch(function (err) {
      results[i] = { error: err, input: inputs[i] };
      done++;
      if (onProgress) onProgress(done, inputs.length, results[i]);
      return worker();
    });
  }

  var pool = [];
  for (var w = 0; w < Math.min(concurrency, inputs.length); w++) {
    pool.push(worker());
  }
  return Promise.all(pool).then(function () { return results; });
}

/* --------------------------------------------------------------------------
   PUBLIC API
   -------------------------------------------------------------------------- */

var PUBLIC_API = {
  version: VERSION,
  compress: compress,
  compressBatch: compressBatch,
  computeSSIM: computeSSIM,
  isFormatSupported: isFormatSupported,
  defaults: DEFAULTS
};
