# FLYBOX 虚拟摄像头 — 实施计划

## 目标

- 系统出现 **FLYBOX Camera**（基于 OBS Windows 虚拟摄像头实现）
- **抖音直播伴侣** 可选中并稳定出画
- 顶栏 **一级模块入口**
- 上架前将本模块按 **GPL** 公开（与 OBS 一致）

## 架构

```
FLYBOX UI（顶栏 → 虚拟摄像头）
    → Tauri/Rust 命令
    → 送帧 / 启停
    → OBS 衍生 virtualcam-module（C/C++ DirectShow DLL）
    → 系统摄像头
    → 抖音直播伴侣
```

源码落地：`src-vcam/obs-win-dshow-vcam/`（来自 OBS `plugins/win-dshow`）

## 阶段

| 阶段 | 内容 | 验收 |
|------|------|------|
| **P0 产品壳** | 顶栏入口 + 模块页 + 状态/说明 | 能点开一级入口 |
| **P1 编译设备** | 独立/半独立编出过滤器 DLL，改名+GUID | 设备管理器/摄像头列表可见 |
| **P2 送帧** | 共享内存队列 + 测试彩条/摄像头原画 | 列表里有活动画面 |
| **P3 伴侣** | 抖音直播伴侣联调 | 伴侣选 FLYBOX 能播 |
| **P4 安装** | 安装包注册/卸载、权限提示 | 安装后即用 |
| **P5 开源** | 上架前公开 GPL 仓 | LICENSE + 源码地址 |

## 当前进度

- [x] 计划文档
- [x] 顶栏一级入口 + 模块 UI（P0）
- [x] 源码 vendored（OBS win-dshow）
- [x] **P1 独立 CMake 编译成功** → `src-vcam/dist/flybox-virtualcam-module64.dll`
- [x] 设备名 **FLYBOX Camera**、独立 GUID、共享内存 `FLYBOXVirtualCamVideo`
- [x] Rust：管理员 regsvr32 安装 + 测试彩条送帧
- [x] **P2 可用路径**：安装 → 开始输出 → 系统可选 FLYBOX Camera（测试彩条）
- [x] 真机原生采集（ffmpeg/dshow）+ 满帧率 SHM；预览读虚拟设备
- [x] 输出预设：1080p30/60、720p30/60；过滤器预宣告多分辨率
- [x] 画质：lanczos/full-chroma；MJPEG/原生阶梯；采集线程高优先级；断线重连
- [x] 规格降级（1080p60→1080p30→720p30）；res 文件原子写；队列 type=VIDEO
- [x] **B** Rust FFI 直链 `video_queue_*`（与过滤器同一份 C，已删手写 ShmWriter）
- [x] **C** 输出中热切换：L1 重建 SHM + L2 伴侣占线缩放兜底（不断输出）
- [x] **A** 安装包 resources 捆绑 DLL + NSIS `hooks.nsh` regsvr32
- [x] **D1** 进程内 MF：采集线程内 COM + stride 打包 NV12；失败回退 ffmpeg
- [x] 状态显示采集方式；UI 规格与后端同步；单测 SHM 占用时 skip
- [ ] **D2** D3D/GPU 路径（可选增强）
- [ ] 无音频虚拟设备（Windows OBS vcam 也主要是视频）
- [ ] P3 抖音直播伴侣完整验收（需本机伴侣 + 人工点选）
- [ ] P5 上架前公开 GPL 仓

## 编译 DLL

在「x64 Native Tools」或先运行 vcvars64.bat：

```bat
cd src-vcam
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
copy /Y build\flybox-virtualcam-module64.dll dist\
```

## 语言

- 设备 DLL / 队列：**C/C++**（沿用 OBS）
- 产品壳：**Rust + React/TS**
