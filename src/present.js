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

/** Palettes as bytes (RGBA, 256 per palette) and as packed little-endian words. */
export function paletteTables(playpal) {
  const npal = Math.min(14, Math.floor(playpal.length / 768));
  const bytes = new Uint8Array(npal * 256 * 4);
  const words = new Uint32Array(npal * 256);
  for (let i = 0; i < npal * 256; i++) {
    const r = playpal[i * 3];
    const g = playpal[i * 3 + 1];
    const b = playpal[i * 3 + 2];
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
