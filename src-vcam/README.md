# FLYBOX Virtual Camera (based on OBS)

Windows virtual camera component for FLYBOX / Flyphoto.

## Upstream

- Source: [obsproject/obs-studio](https://github.com/obsproject/obs-studio)
- Path: `plugins/win-dshow` (includes `virtualcam-module` + frame push helpers)
- License: **GPL-2.0** (see `COPYING-obs-studio` when present; OBS Studio license)
- Vendored for private development; **public GPL release at product launch** (per product plan)

## Layout

```
src-vcam/
  README.md                 # this file
  COPYING-obs-studio        # OBS license text (when vendored)
  obs-win-dshow-vcam/       # copy of OBS plugins/win-dshow
    virtualcam.c            # OBS-side virtual cam output
    shared-memory-queue.*   # shared-memory frame queue
    tiny-nv12-scale.*       # NV12 scale helpers
    virtualcam-module/      # DirectShow filter DLL (system camera device)
    win-dshow.cpp           # also contains real DirectShow capture (upstream bundle)
    ...
```

## Planned FLYBOX changes (not done yet)

1. Rename device to **FLYBOX Camera** (or product name)
2. Replace virtual camera **GUID** (must not clash with official OBS VCam)
3. Standalone build (or slim CMake without full OBS frontend)
4. FLYBOX / Tauri pushes frames into the shared-memory queue
5. Installer registers/unregisters the filter DLL
6. Accept test: Douyin 直播伴侣 can select the device and show video

## Build note

Upstream `win-dshow` depends on **libobs** and OBS CMake tree.  
This folder is a **source drop** for development; linking into a standalone DLL still needs OBS build deps or a trimmed CMake (next step).

## Status

- [x] Vendor OBS win-dshow sources into repo
- [x] Product shell: top-bar module + UI + Rust stubs (`vcam_*`)
- [ ] Independent build of filter DLL
- [ ] Rename + new GUID (FLYBOX Camera)
- [ ] FLYBOX frame sender
- [ ] 直播伴侣 smoke test
