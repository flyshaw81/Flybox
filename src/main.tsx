import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// 桌面软件：全局禁用浏览器右键菜单（业务菜单自行 preventDefault + 自定义 UI）
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
