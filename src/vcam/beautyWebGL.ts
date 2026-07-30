/**
 * GPU beauty preview — dedicated offscreen WebGL canvas → blit to stage 2d.
 * Reference idea: livestream bilateral Y/U/V (biliobs family), rewritten for WebGL1/ANGLE.
 *
 * Hard constraints for WebView2:
 * - GLSL ES 1.00 only (use webgl, not webgl2 first)
 * - No `continue` in loops
 * - Constant loop bounds with +1 step
 */

export type BeautyGLParams = {
  smooth: number;
  whiten: number;
};

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_selfW;
uniform float u_yTh;
uniform float u_uvTh;
uniform float u_whiten;
uniform float u_doSmooth;
uniform float u_smoothAmt;
varying vec2 v_uv;

vec3 toYuv(vec3 c) {
  float y = dot(c, vec3(0.30, 0.587, 0.114));
  float u = 0.5 * (c.b - y) / 0.886;
  float v = 0.5 * (c.r - y) / 0.701;
  return vec3(y, u, v);
}

void main() {
  vec4 center = texture2D(u_tex, v_uv);
  vec3 col = center.rgb;
  vec3 cyuv = toYuv(center.rgb);

  // Edge-aware soft base (not pure blur), then high-pass put texture back
  // = 磨皮 feel: even skin tone, keep pores/micro detail
  if (u_doSmooth > 0.5) {
    vec3 acc = center.rgb * u_selfW;
    float wsum = u_selfW;
    for (int j = 0; j < 5; j++) {
      for (int i = 0; i < 5; i++) {
        float fi = float(i) - 2.0;
        float fj = float(j) - 2.0;
        float isCenter = step(abs(fi) + abs(fj), 0.01);
        float use = 1.0 - isCenter;
        vec2 uv = v_uv + u_texel * vec2(fi, fj);
        vec4 s = texture2D(u_tex, clamp(uv, 0.0, 1.0));
        vec3 sy = toYuv(s.rgb);
        float dy = abs(sy.x - cyuv.x) / max(u_yTh, 0.001);
        float du = abs(sy.y - cyuv.y) / max(u_uvTh, 0.001);
        float dv = abs(sy.z - cyuv.z) / max(u_uvTh, 0.001);
        float edge = max(dy, max(du, dv));
        // tighter edge keep than old blur-path (protect hairline / jaw)
        float accept = 1.0 - smoothstep(0.55, 1.25, edge);
        acc += mix(center.rgb, s.rgb, accept) * use;
        wsum += use;
      }
    }
    // Wider ring: low-freq only (blemish / uneven tone)
    for (int j = 0; j < 5; j++) {
      for (int i = 0; i < 5; i++) {
        float fi = (float(i) - 2.0) * 2.5;
        float fj = (float(j) - 2.0) * 2.5;
        float near = step(abs(fi) + abs(fj), 3.0);
        float use = 1.0 - near;
        vec2 uv = v_uv + u_texel * vec2(fi, fj);
        vec4 s = texture2D(u_tex, clamp(uv, 0.0, 1.0));
        vec3 sy = toYuv(s.rgb);
        float dy = abs(sy.x - cyuv.x) / max(u_yTh * 1.15, 0.001);
        float du = abs(sy.y - cyuv.y) / max(u_uvTh * 1.1, 0.001);
        float dv = abs(sy.z - cyuv.z) / max(u_uvTh * 1.1, 0.001);
        float edge = max(dy, max(du, dv));
        float accept = 1.0 - smoothstep(0.5, 1.2, edge);
        acc += mix(center.rgb, s.rgb, accept) * use * 0.85;
        wsum += use * 0.85;
      }
    }
    // Approximate frequency separation: soft ≈ mid+low; put high back fully
    // smooth=0 never enters this branch (u_doSmooth)
    vec3 soft = acc / max(wsum, 1.0);
    vec3 high = center.rgb - soft;
    float midKill = u_smoothAmt * 0.75;
    vec3 retouched = soft + high * (1.0 + u_smoothAmt * 0.10);
    // Soft curve at low slider so "near zero" is almost original
    float blend = u_smoothAmt * u_smoothAmt * 0.50 + u_smoothAmt * 0.30;
    col = mix(center.rgb, retouched, blend * (0.55 + 0.45 * (1.0 - midKill * 0.3)));
    col = clamp(col, 0.0, 1.0);
  }

  // Whitening: lift ALL tones incl. bright forehead (warm, not gray)
  if (u_whiten > 0.001) {
    float y = cyuv.x;
    float toneW = 0.62 + 0.38 * (1.0 - y * y);
    float amount = u_whiten * toneW;
    vec3 lifted = col * (1.0 + amount * 0.18);
    vec3 target = vec3(1.0, 0.99, 0.97);
    col = mix(lifted, target, amount * 0.12);
    col = clamp(col, 0.0, 1.0);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

type GLState = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  tex: WebGLTexture;
  buf: WebGLBuffer;
  aPos: number;
  loc: {
    tex: WebGLUniformLocation | null;
    texel: WebGLUniformLocation | null;
    selfW: WebGLUniformLocation | null;
    yTh: WebGLUniformLocation | null;
    uvTh: WebGLUniformLocation | null;
    whiten: WebGLUniformLocation | null;
    doSmooth: WebGLUniformLocation | null;
    smoothAmt: WebGLUniformLocation | null;
  };
};

let glCanvas: HTMLCanvasElement | null = null;
let state: GLState | null = null;
let lastError = "";

export function getBeautyGLError(): string {
  return lastError;
}

function compile(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    lastError = "shader: " + (gl.getShaderInfoLog(sh) || "compile fail");
    console.error("[beauty-gl]", lastError);
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function resetBeautyGL() {
  if (state) {
    try {
      const gl = state.gl;
      gl.deleteProgram(state.prog);
      gl.deleteTexture(state.tex);
      gl.deleteBuffer(state.buf);
      const ext = gl.getExtension("WEBGL_lose_context");
      ext?.loseContext();
    } catch {
      /* ignore */
    }
  }
  state = null;
  glCanvas = null;
}

// HMR: drop old program so new fragment shader recompiles
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetBeautyGL();
  });
}

function ensureGL(): GLState | null {
  if (state) return state;

  glCanvas = document.createElement("canvas");
  glCanvas.width = 4;
  glCanvas.height = 4;

  // WebGL1 only first — more predictable GLSL ES 1.00 in WebView2/ANGLE
  const gl = (glCanvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
    powerPreference: "default",
  }) ||
    glCanvas.getContext("experimental-webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    })) as WebGLRenderingContext | null;

  if (!gl) {
    lastError = "WebGL 不可用";
    return null;
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;

  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "a_pos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    lastError = "link: " + (gl.getProgramInfoLog(prog) || "fail");
    console.error("[beauty-gl]", lastError);
    return null;
  }

  const buf = gl.createBuffer()!;
  const tex = gl.createTexture()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Clear sticky errors
  while (gl.getError() !== gl.NO_ERROR) {
    /* drain */
  }

  state = {
    gl,
    prog,
    tex,
    buf,
    aPos: 0,
    loc: {
      tex: gl.getUniformLocation(prog, "u_tex"),
      texel: gl.getUniformLocation(prog, "u_texel"),
      selfW: gl.getUniformLocation(prog, "u_selfW"),
      yTh: gl.getUniformLocation(prog, "u_yTh"),
      uvTh: gl.getUniformLocation(prog, "u_uvTh"),
      whiten: gl.getUniformLocation(prog, "u_whiten"),
      doSmooth: gl.getUniformLocation(prog, "u_doSmooth"),
      smoothAmt: gl.getUniformLocation(prog, "u_smoothAmt"),
    },
  };
  lastError = "";
  console.info("[beauty-gl] OK", gl.getParameter(gl.VERSION));
  return state;
}

function mapParams(smooth: number, whiten: number) {
  // Hard gate: bottom of slider = no smooth at all
  const t = Math.max(0, Math.min(1, smooth));
  const doS = t > 0.015 ? 1 : 0;
  return {
    selfW: 16 - t * 6,
    yTh: 0.05 + t * 0.06,
    uvTh: 0.028 + t * 0.035,
    w: Math.max(0, Math.min(1, whiten)) * 1.15,
    doSmooth: doS,
    smoothAmt: doS > 0 ? t : 0,
  };
}

export function paintBeautyWebGL(
  video: HTMLVideoElement,
  stageCanvas: HTMLCanvasElement,
  params: BeautyGLParams,
): boolean {
  const vw = video.videoWidth | 0;
  const vh = video.videoHeight | 0;
  if (vw < 2 || vh < 2) {
    lastError = "video not ready";
    return false;
  }

  let st = ensureGL();
  if (!st || !glCanvas) return false;

  const { gl, prog, tex, buf, aPos, loc } = st;

  try {
    if (glCanvas.width !== vw || glCanvas.height !== vh) {
      glCanvas.width = vw;
      glCanvas.height = vh;
    }
    gl.viewport(0, 0, vw, vh);
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    const m = mapParams(params.smooth, params.whiten);
    gl.uniform1i(loc.tex, 0);
    gl.uniform2f(loc.texel, 1 / vw, 1 / vh);
    gl.uniform1f(loc.selfW, m.selfW);
    gl.uniform1f(loc.yTh, m.yTh);
    gl.uniform1f(loc.uvTh, m.uvTh);
    gl.uniform1f(loc.whiten, m.w);
    gl.uniform1f(loc.doSmooth, m.doSmooth);
    gl.uniform1f(loc.smoothAmt, m.smoothAmt);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const gerr = gl.getError();
    if (gerr !== gl.NO_ERROR) {
      lastError = "glError=" + gerr;
      resetBeautyGL();
      return false;
    }

    if (stageCanvas.width !== vw || stageCanvas.height !== vh) {
      stageCanvas.width = vw;
      stageCanvas.height = vh;
    }
    const ctx = stageCanvas.getContext("2d", { alpha: false });
    if (!ctx) {
      lastError = "stage 2d blocked";
      return false;
    }
    ctx.drawImage(glCanvas, 0, 0, vw, vh);
    lastError = "";
    return true;
  } catch (e) {
    lastError = String(e);
    console.error("[beauty-gl]", e);
    resetBeautyGL();
    return false;
  }
}
