/** 扫码登录后首次抓数据：飞车 loading（无背景、无云） */
export default function LiveSpeederLoader({ label }: { label?: string }) {
  return (
    <div className="live-speeder-wrap">
      <div className="live-speeder" aria-hidden>
        <div className="live-speeder-loader">
          <span>
            <span />
            <span />
            <span />
            <span />
          </span>
          <div className="live-speeder-base">
            <span />
            <div className="live-speeder-face" />
          </div>
        </div>
        <div className="live-speeder-trails">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
      {label ? <p className="muted live-speeder-label">{label}</p> : null}
    </div>
  );
}
