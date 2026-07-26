# FLYBOX

极简本地图库：像 Obsidian 打开 vault 一样，指定一个文件夹即可浏览图片。

## 功能

- 选择文件夹作为图库根目录（记住上次路径）
- 瀑布流浏览 / 单张浏览
- 大图灯箱，滚轮或按钮放大缩小
- 复制图片（剪贴板）/ 删除磁盘文件
- 本地优先，无账号、无云同步

## 开发

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build
```

安装包在 `src-tauri/target/release/bundle/` 下。
