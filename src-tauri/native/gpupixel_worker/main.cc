// GPUPixel headless beauty worker for FLYBOX virtual camera.
// Protocol (little-endian):
//   request:  magic "FB01" | u32 w | u32 h | f32 smooth | f32 whiten | f32 slim | RGBA
//   response: magic "FB01" | u32 w | u32 h | RGBA
//   quit:     "QUIT"
//
// Windows package has no FaceDetector export — smooth/whiten only.
// Critical: SetSharpen after blur (shader: color = blurMix + sharpen * highPass).

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include <fcntl.h>
#include <io.h>
#include <windows.h>

#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>

#include "gpupixel/gpupixel.h"

using namespace gpupixel;

static const char kMagic[4] = {'F', 'B', '0', '1'};

static HANDLE g_in = INVALID_HANDLE_VALUE;
static HANDLE g_out = INVALID_HANDLE_VALUE;

static std::string ExeDir() {
  char buf[MAX_PATH] = {};
  GetModuleFileNameA(nullptr, buf, MAX_PATH);
  std::string p(buf);
  const auto pos = p.find_last_of("\\/");
  if (pos != std::string::npos) {
    p.resize(pos);
  }
  return p;
}

static bool ReadExact(void* dst, size_t n) {
  auto* p = static_cast<uint8_t*>(dst);
  size_t got = 0;
  while (got < n) {
    DWORD r = 0;
    if (!ReadFile(g_in, p + got, static_cast<DWORD>(n - got), &r, nullptr) ||
        r == 0) {
      return false;
    }
    got += r;
  }
  return true;
}

static bool WriteExact(const void* src, size_t n) {
  auto* p = static_cast<const uint8_t*>(src);
  size_t done = 0;
  while (done < n) {
    DWORD w = 0;
    if (!WriteFile(g_out, p + done, static_cast<DWORD>(n - done), &w,
                   nullptr) ||
        w == 0) {
      return false;
    }
    done += w;
  }
  return true;
}

static void DivertCrtStdoutToStderr() {
  const int fd_err = _fileno(stderr);
  const int fd_out = _fileno(stdout);
  if (fd_err >= 0 && fd_out >= 0) {
    _dup2(fd_err, fd_out);
  }
  std::cout.rdbuf(std::cerr.rdbuf());
}

int main() {
  g_in = GetStdHandle(STD_INPUT_HANDLE);
  g_out = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE proc = GetCurrentProcess();
  HANDLE in_dup = INVALID_HANDLE_VALUE;
  HANDLE out_dup = INVALID_HANDLE_VALUE;
  DuplicateHandle(proc, g_in, proc, &in_dup, 0, FALSE, DUPLICATE_SAME_ACCESS);
  DuplicateHandle(proc, g_out, proc, &out_dup, 0, FALSE, DUPLICATE_SAME_ACCESS);
  g_in = in_dup;
  g_out = out_dup;

  _setmode(_fileno(stderr), _O_TEXT);
  DivertCrtStdoutToStderr();

  const std::string dir = ExeDir();
  SetDllDirectoryA(dir.c_str());
  GPUPixel::SetResourcePath(dir);

  fprintf(stderr, "gpupixel_worker start dir=%s\n", dir.c_str());
  fflush(stderr);

  if (!glfwInit()) {
    fprintf(stderr, "glfwInit failed\n");
    fflush(stderr);
    return 1;
  }

  glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);
  GLFWwindow* window =
      glfwCreateWindow(64, 64, "gpupixel_worker", nullptr, nullptr);
  if (!window) {
    fprintf(stderr, "glfwCreateWindow failed\n");
    fflush(stderr);
    glfwTerminate();
    return 1;
  }
  glfwMakeContextCurrent(window);

  auto source = SourceRawData::Create();
  auto beauty = BeautyFaceFilter::Create();
  auto sink = SinkRawData::Create();

  if (!source || !beauty || !sink) {
    fprintf(stderr, "filter Create failed source=%d beauty=%d sink=%d\n",
            source ? 1 : 0, beauty ? 1 : 0, sink ? 1 : 0);
    fflush(stderr);
    return 1;
  }

  source->AddSink(beauty)->AddSink(sink);

  // Gentler base than library default radius=4 (too soft/foggy on webcam).
  beauty->SetRadius(2.5f);
  beauty->SetHighPassDelta(0.8f);
  beauty->SetSharpen(0.0f);
  beauty->SetBlurAlpha(0.0f);
  beauty->SetWhite(0.0f);

  fprintf(stderr, "gpupixel_worker ready (BeautyFaceFilter+sharpen)\n");
  fflush(stderr);

  std::vector<uint8_t> rgba;
  for (;;) {
    char magic[4] = {};
    if (!ReadExact(magic, 4)) {
      break;
    }
    if (std::memcmp(magic, "QUIT", 4) == 0) {
      break;
    }
    if (std::memcmp(magic, kMagic, 4) != 0) {
      fprintf(stderr, "bad magic\n");
      fflush(stderr);
      break;
    }

    uint32_t w = 0, h = 0;
    float smooth = 0.f, whiten = 0.f, slim = 0.f;
    if (!ReadExact(&w, 4) || !ReadExact(&h, 4) || !ReadExact(&smooth, 4) ||
        !ReadExact(&whiten, 4) || !ReadExact(&slim, 4)) {
      break;
    }
    if (w < 8 || h < 8 || w > 4096 || h > 4096) {
      fprintf(stderr, "bad size %ux%u\n", w, h);
      fflush(stderr);
      break;
    }

    const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h) * 4u;
    rgba.resize(n);
    if (!ReadExact(rgba.data(), n)) {
      break;
    }

    // UI 0..1 → GPUPixel (aligned with official demo app.cc curves)
    // demo: SetBlurAlpha(slider0_10 / 10) → 0..1
    // demo: SetWhite(slider0_10 / 20) → 0..0.5
    const float s = std::clamp(smooth, 0.f, 1.f);
    const float wh = std::clamp(whiten, 0.f, 1.f);
    (void)slim;

    // Soft blur radius grows with smooth; keep lower than lib default 4.
    beauty->SetRadius(2.0f + s * 1.8f);          // 2.0 .. 3.8
    beauty->SetBlurAlpha(s);
    // Shader restores edges: color = mix + sharpen * highPass * 2
    // Without this, face becomes plastic fog — root cause of "garbage" look.
    beauty->SetSharpen(s * 0.55f);
    beauty->SetWhite(wh * 0.40f);                // 0 .. 0.40 (avoid pink blowout)
    beauty->SetHighPassDelta(0.6f + s * 0.5f);

    source->ProcessData(rgba.data(), static_cast<int>(w), static_cast<int>(h),
                        static_cast<int>(w * 4), GPUPIXEL_FRAME_TYPE_RGBA);

    const uint8_t* out_ptr = sink->GetRgbaBuffer();
    const int ow = sink->GetWidth();
    const int oh = sink->GetHeight();
    if (!out_ptr || ow != static_cast<int>(w) || oh != static_cast<int>(h)) {
      out_ptr = rgba.data();
    }

    if (!WriteExact(kMagic, 4) || !WriteExact(&w, 4) || !WriteExact(&h, 4) ||
        !WriteExact(out_ptr, n)) {
      break;
    }
  }

  glfwDestroyWindow(window);
  glfwTerminate();
  fprintf(stderr, "gpupixel_worker exit\n");
  fflush(stderr);
  return 0;
}
