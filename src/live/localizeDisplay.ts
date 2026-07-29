/** Map Douyin Chinese labels → English for display only (does not rewrite stored data). */

const CHANNEL_MAP: Record<string, string> = {
  直播推荐: "Live feed",
  视频推荐: "Video feed",
  推荐feed: "Recommend feed",
  其他: "Other",
  关注页: "Following page",
  关注: "Following",
  消息: "Messages",
  站内横幅: "In-app banner",
  "站内横幅(push)": "In-app banner (push)",
  直播广场: "Live plaza",
  同城: "Nearby",
  搜索: "Search",
  个人主页: "Profile",
  主页: "Profile",
  活动页: "Campaign",
  付费流量: "Paid traffic",
  商业化: "Ads",
  自然流量: "Organic",
  粉丝: "Fans",
  访客: "Visitors",
  分享: "Share",
  购物车: "Shop cart",
  品牌: "Brand",
  头条: "Top stories",
  西瓜: "Xigua",
  火山: "Huoshan",
};

const WORD_MAP: Record<string, string> = {
  男性: "male",
  女性: "female",
  非粉丝: "non-fans",
  粉丝: "fans",
  居多: "",
  二次元: "anime/2D",
  随拍: "casual clips",
  游戏: "gaming",
  美食: "food",
  音乐: "music",
  舞蹈: "dance",
  颜值: "looks",
  生活: "lifestyle",
  加入: "join",
  用户: "users",
  级: "Lv",
};

export function localizeChannelName(name: string, locale: string): string {
  if (locale !== "en" || !name) return name;
  if (CHANNEL_MAP[name]) return CHANNEL_MAP[name];
  // e.g. 站内横幅(push)
  for (const [zh, en] of Object.entries(CHANNEL_MAP)) {
    if (name.includes(zh)) return name.split(zh).join(en);
  }
  return name;
}

export function localizeAgeBucket(name: string, locale: string): string {
  if (locale !== "en" || !name) return name;
  return name
    .replace(/(\d+)\s*-\s*(\d+)\s*岁/g, "$1–$2")
    .replace(/(\d+)\s*岁以上/g, "$1+")
    .replace(/岁/g, "");
}

/** Portrait free-text: gender / age / region / hobby / fans mix / comments */
export function localizePortraitText(
  text: string | null | undefined,
  locale: string,
): string | null | undefined {
  if (locale !== "en" || text == null) return text;
  let s = text;
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*男性/g, "$1% male");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*女性/g, "$1% female");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*非粉丝/g, "$1% non-fans");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*粉丝/g, "$1% fans");
  s = s.replace(/(\d+)\s*-\s*(\d+)\s*岁/g, "$1–$2");
  s = s.replace(/(\d+)\s*岁以上/g, "$1+");
  s = s.replace(/(\d+)\s*-\s*(\d+)\s*级\s*用户/g, "Lv$1–$2 users");
  s = s.replace(/(\d+)\s*级以上\s*用户/g, "Lv$1+ users");
  s = s.replace(/(\d+)\s*-\s*(\d+)\s*级/g, "Lv$1–$2");
  s = s.replace(/(\d+)\s*级/g, "Lv$1");
  s = s.replace(/、/g, ", ");
  s = s.replace(/，/g, ", ");
  for (const [zh, en] of Object.entries(WORD_MAP)) {
    if (!zh) continue;
    s = s.split(zh).join(en);
  }
  s = s.replace(/\s{2,}/g, " ").replace(/,\s*,+/g, ",").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
  return s;
}
