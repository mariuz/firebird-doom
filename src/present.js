// present.js – the last step: DOOM's 320×200 palette-index screen onto the canvas.
//
// The renderer works the way DOOM did: every pixel is a palette index, already
// lit through COLORMAP. Which of the 14 PLAYPAL palettes turns those indices
// into colours – normal, pain red, pickup gold, radiation-suit green – is only
// decided here, once per frame (I_SetPalette).
//
//   WebGLPresenter    uploads the indices as a texture; a fragment shader
//                     looks each one up in a 256×14 palette texture. Smooth
//                     upscaling filters the *colours* (bilinear in the shader),
//                     never the indices.
//   Canvas2DPresenter the fallback: a palette loop and putImageData; smooth
//                     upscaling is the browser's image smoothing.
//
// A canvas keeps the kind of context it first gave out, so switching between
// them needs a fresh canvas element (main.js does that).

// v_video.c's gammatable: I_SetPalette runs every palette byte through the
// row for the gamma level (F11: off, then 1–4, each lifting the dark end more).
export const GAMMA_TABLES = [
  Uint8Array.from([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255]),
  Uint8Array.from([2,4,5,7,8,10,11,12,14,15,16,18,19,20,21,23,24,25,26,27,29,30,31,32,33,34,36,37,38,39,40,41,42,44,45,46,47,48,49,50,51,52,54,55,56,57,58,59,60,61,62,63,64,65,66,67,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,163,164,165,166,167,168,169,170,171,172,173,174,175,175,176,177,178,179,180,181,182,183,184,185,186,186,187,188,189,190,191,192,193,194,195,196,196,197,198,199,200,201,202,203,204,205,205,206,207,208,209,210,211,212,213,214,214,215,216,217,218,219,220,221,222,222,223,224,225,226,227,228,229,230,230,231,232,233,234,235,236,237,237,238,239,240,241,242,243,244,245,245,246,247,248,249,250,251,252,252,253,254,255]),
  Uint8Array.from([4,7,9,11,13,15,17,19,21,22,24,26,27,29,30,32,33,35,36,38,39,40,42,43,45,46,47,48,50,51,52,54,55,56,57,59,60,61,62,63,65,66,67,68,69,70,72,73,74,75,76,77,78,79,80,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,133,134,135,136,137,138,139,140,141,142,143,144,144,145,146,147,148,149,150,151,152,153,153,154,155,156,157,158,159,160,160,161,162,163,164,165,166,166,167,168,169,170,171,172,172,173,174,175,176,177,178,178,179,180,181,182,183,183,184,185,186,187,188,188,189,190,191,192,193,193,194,195,196,197,197,198,199,200,201,201,202,203,204,205,206,206,207,208,209,210,210,211,212,213,213,214,215,216,217,217,218,219,220,221,221,222,223,224,224,225,226,227,228,228,229,230,231,231,232,233,234,235,235,236,237,238,238,239,240,241,241,242,243,244,244,245,246,247,247,248,249,250,251,251,252,253,254,254,255]),
  Uint8Array.from([8,12,16,19,22,24,27,29,31,34,36,38,40,41,43,45,47,49,50,52,53,55,57,58,60,61,63,64,65,67,68,70,71,72,74,75,76,77,79,80,81,82,84,85,86,87,88,90,91,92,93,94,95,96,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,135,136,137,138,139,140,141,142,143,143,144,145,146,147,148,149,150,150,151,152,153,154,155,155,156,157,158,159,160,160,161,162,163,164,165,165,166,167,168,169,169,170,171,172,173,173,174,175,176,176,177,178,179,180,180,181,182,183,183,184,185,186,186,187,188,189,189,190,191,192,192,193,194,195,195,196,197,197,198,199,200,200,201,202,202,203,204,205,205,206,207,207,208,209,210,210,211,212,212,213,214,214,215,216,216,217,218,219,219,220,221,221,222,223,223,224,225,225,226,227,227,228,229,229,230,231,231,232,233,233,234,235,235,236,237,237,238,238,239,240,240,241,242,242,243,244,244,245,246,246,247,247,248,249,249,250,251,251,252,253,253,254,254,255]),
  Uint8Array.from([16,23,28,32,36,39,42,45,48,50,53,55,57,60,62,64,66,68,69,71,73,75,76,78,80,81,83,84,86,87,89,90,92,93,94,96,97,98,100,101,102,103,105,106,107,108,109,110,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,128,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,143,144,145,146,147,148,149,150,150,151,152,153,154,155,155,156,157,158,159,159,160,161,162,163,163,164,165,166,166,167,168,169,169,170,171,172,172,173,174,175,175,176,177,177,178,179,180,180,181,182,182,183,184,184,185,186,187,187,188,189,189,190,191,191,192,193,193,194,195,195,196,196,197,198,198,199,200,200,201,202,202,203,203,204,205,205,206,207,207,208,208,209,210,210,211,211,212,213,213,214,214,215,216,216,217,217,218,219,219,220,220,221,221,222,223,223,224,224,225,225,226,227,227,228,228,229,229,230,230,231,232,232,233,233,234,234,235,235,236,236,237,237,238,239,239,240,240,241,241,242,242,243,243,244,244,245,245,246,246,247,247,248,248,249,249,250,250,251,251,252,252,253,254,254,255,255]),
];

/**
 * Palettes as bytes (RGBA, 256 per palette) and as packed little-endian words,
 * through gamma level GAMMA's table (0–4; even "off" lifts by one, as DOOM's
 * does), or as the WAD has them with GAMMA null.
 */
export function paletteTables(playpal, gamma = null) {
  const npal = Math.min(14, Math.floor(playpal.length / 768));
  const bytes = new Uint8Array(npal * 256 * 4);
  const words = new Uint32Array(npal * 256);
  const table = gamma == null ? null : GAMMA_TABLES[Math.max(0, Math.min(4, gamma | 0))];
  const at = (v) => (table ? table[v] : v);
  for (let i = 0; i < npal * 256; i++) {
    const r = at(playpal[i * 3]);
    const g = at(playpal[i * 3 + 1]);
    const b = at(playpal[i * 3 + 2]);
    bytes.set([r, g, b, 255], i * 4);
    words[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return { npal, bytes, words };
}

export class Canvas2DPresenter {
  constructor(canvas) {
    this.kind = '2d';
    this.canvas = canvas;
    canvas.width = 320;
    canvas.height = 200;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('no 2D canvas context');
    this.image = new ImageData(320, 200);
    this.out = new Uint32Array(this.image.data.buffer);
    this.words = null;
  }

  setPalettes(tables) { this.words = tables.words; this.npal = tables.npal; }

  setSmooth(smooth) {
    // 320×200 stretched by CSS: the browser's own filtering does the smoothing
    if (this.canvas.style) this.canvas.style.imageRendering = smooth ? 'auto' : 'pixelated';
  }

  present(screen, palette) {
    if (!this.words) return;
    const base = Math.min(palette, this.npal - 1) * 256;
    const { out, words } = this;
    for (let i = 0; i < 64000; i++) out[i] = words[base + screen[i]];
    this.ctx.putImageData(this.image, 0, 0);
  }
}

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x + 1.0, 1.0 - aPos.y) * 0.5;   // the screen's first row at the top
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uScreen;   // 320×200 palette indices (LUMINANCE)
uniform sampler2D uPal;      // 256 × npal colours
uniform float uRow;          // which palette, as a texture row centre
uniform vec2 uSize;
uniform bool uSmooth;
varying vec2 vUv;

vec3 colour(vec2 uv) {
  float index = floor(texture2D(uScreen, uv).r * 255.0 + 0.5);
  return texture2D(uPal, vec2((index + 0.5) / 256.0, uRow)).rgb;
}

void main() {
  if (!uSmooth) {
    gl_FragColor = vec4(colour(vUv), 1.0);
    return;
  }
  // bilinear between the four nearest pixels' colours
  vec2 p = vUv * uSize - 0.5;
  vec2 f = fract(p);
  vec2 b = (floor(p) + 0.5) / uSize;
  vec2 d = 1.0 / uSize;
  vec3 top = mix(colour(b), colour(b + vec2(d.x, 0.0)), f.x);
  vec3 bottom = mix(colour(b + vec2(0.0, d.y)), colour(b + d), f.x);
  gl_FragColor = vec4(mix(top, bottom, f.y), 1.0);
}`;

export class WebGLPresenter {
  constructor(canvas) {
    this.kind = 'webgl';
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('no WebGL');
    this.gl = gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(prog)}`);
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const texture = (unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      // NEAREST always: indices must never be blended
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.screenTex = texture(0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 320, 200, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
    this.palTex = texture(1);
    this.u = {
      row: gl.getUniformLocation(prog, 'uRow'),
      smooth: gl.getUniformLocation(prog, 'uSmooth'),
    };
    gl.uniform1i(gl.getUniformLocation(prog, 'uScreen'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uPal'), 1);
    gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), 320, 200);
    this.npal = 0;
    this.smooth = false;
  }

  setPalettes(tables) {
    const { gl } = this;
    this.npal = tables.npal;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, tables.npal, 0, gl.RGBA, gl.UNSIGNED_BYTE, tables.bytes);
  }

  setSmooth(smooth) {
    this.smooth = smooth;
    if (this.canvas.style) this.canvas.style.imageRendering = 'auto';   // the shader scales, not CSS
  }

  present(screen, palette) {
    const { gl, canvas } = this;
    if (!this.npal) return;
    // draw at the size the canvas is shown, so upscaling happens here
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(320, Math.round((canvas.clientWidth || 640) * dpr));
    const h = Math.max(200, Math.round((canvas.clientHeight || 480) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.screenTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 320, 200, gl.LUMINANCE, gl.UNSIGNED_BYTE, screen);
    gl.uniform1f(this.u.row, (Math.min(palette, this.npal - 1) + 0.5) / this.npal);
    gl.uniform1i(this.u.smooth, this.smooth ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/** A presenter of the asked-for kind on this canvas, or null if it can't be had. */
export function createPresenter(canvas, display) {
  try {
    return display === 'webgl' ? new WebGLPresenter(canvas) : new Canvas2DPresenter(canvas);
  } catch (err) {
    console.warn(`[firebird-doom] ${display} presenter unavailable: ${err.message}`);
    return null;
  }
}
