# FLYBOX / Flyphoto 项目规则

## 版本号（用户硬性要求，写死）

**只要发版相关（打包 / 给客户安装包 / 正式安装本机最新版），必须先升版本号再打。**  
禁止还用旧号打出「最新包」；禁止用户没说升版却在普通修 bug 时偷偷 bump（普通改代码可以不升；**一说打包就升**）。

### 写法（规则：`v0.1.x`）

- **对外展示一律** `v0.1.x`（带 `v` 前缀，如 `v0.1.1`、`v0.1.2`）
- **每次打包补丁 +1**：`v0.1.1` → `v0.1.2` → … **禁止跳号、禁止停在旧号打「新包」**
- **构建 semver**（Cargo/tauri）与展示去掉 `v` 后一致：`v0.1.1` ↔ `0.1.1`

### 防误毁（血泪）

- **禁止**因「换了正式版 exe / 重装 / 升级」触发密码箱全盘销毁  
- exe 指纹变化只能**重封守卫**，不能 `wipe_all_app_data`

### 改版本时必须同步

1. `package.json` → `version`（semver，如 `0.1.1`）
2. `src-tauri/tauri.conf.json` → `version`
3. `src-tauri/Cargo.toml` → `version`
4. `src/appVersion.ts` → `APP_VERSION`（= 构建号）+ `APP_VERSION_LABEL`（= `v0.1.xx` 展示）  
   **禁止**在设置页再写死旧字符串（曾导致界面一直显示 0.1.0 / 像「0.10」）

### 打包验收（说「打包」时整条做完）

1. **先升版本号**（本条）
2. 关掉正在跑的 FLYBOX / flyphoto（避免锁文件）
3. `npm run tauri build` 打出安装包
4. 静默安装到本机（NSIS `/S`）
5. 启动一次，确认进程起来
6. 汇报打勾：打包完成 / 已安装 / 已启动 / **安装包路径** / 本机安装路径 / **新版本号**

## DarkVeil 跟强调色（已校准）

背景音乐舞台用 React Bits `DarkVeil`，**换色只走 `hueShift`**（见 `src/DarkVeil.tsx` / `.cursor/rules/darkveil-accent.mdc`）。

- 读 CSS `--accent` → `hueShiftFromAccentVar()`
- 公式：`shift = 290 - accentHue + (-40)`，再夹到 `[-180, 180]`（正向偏绿，负向暖色；`-40` 把爱马仕橙从偏红扳正）
- **禁止**再上 accent 混色 / HSV 硬染；要微调颜色只动 `VEIL_BASE_HUE` / `WARM_BIAS`

## 其它

- 用户没点名的事不要做；发现可优化先问
- 用户完全不懂代码：运维/报错在已授权任务内直接做完，用人话汇报
- 播放台界面勿堆「循环中 / 淡变中」等工程化状态文案
