import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/noto-sans-sc";
import App from "./App";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./theme";
import FlyTooltip from "./FlyTooltip";
import "./App.css";
import "./live/live.css";

// 桌面软件：全局禁用浏览器右键菜单（业务菜单自行 preventDefault + 自定义 UI）
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

/** 热更新/异常时避免整页空白 */
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FLYBOX render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            fontFamily: "system-ui, sans-serif",
            color: "#f2f2f2",
            background: "#0a0a0a",
            height: "100%",
            boxSizing: "border-box",
          }}
        >
          <h2 style={{ marginTop: 0 }}>界面出错了</h2>
          <p style={{ opacity: 0.75 }}>关掉窗口再开一次开发版即可。若还崩，把下面内容发我：</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#161616",
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            style={{
              marginTop: 12,
              padding: "8px 14px",
              background: "#ff6a00",
              color: "#fff",
              border: 0,
              borderRadius: 8,
              cursor: "pointer",
            }}
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <I18nProvider>
        <ThemeProvider>
          <App />
          <FlyTooltip />
        </ThemeProvider>
      </I18nProvider>
    </RootErrorBoundary>
  </React.StrictMode>,
);
