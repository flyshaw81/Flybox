import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/noto-sans-sc";
import App from "./App";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./theme";
import FlyTooltip from "./FlyTooltip";
import "./App.css";

// 桌面软件：全局禁用浏览器右键菜单（业务菜单自行 preventDefault + 自定义 UI）
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <App />
        <FlyTooltip />
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);
