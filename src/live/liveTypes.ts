export type LiveStatus = "live" | "ended" | "idle" | "unknown";

export type LiveDataPoint = {
  t: number;
  viewers: number;
  likes: number;
  gifts: number;
  comments: number;
  giftSenders?: number;
  newFollowers?: number;
  newFansClub?: number;
  shares?: number;
};

/** 抖音 overview_v3 深采字段（可选） */
export type LiveSessionDeep = {
  watchUcnt?: number;
  enterUcnt?: number;
  enterRate?: number;
  avgWatchMins?: number;
  consumeUcnt?: number;
  consumeRate?: number;
  showUcnt?: number;
  earnScoreDiff?: number;
};

/** 抖音复盘「观众画像 / 全部观众」 */
export type AudienceBucket = {
  name: string;
  pct: number;
};

export type AudiencePortrait = {
  genderText?: string | null;
  genderMost?: string | null;
  malePct?: number | null;
  femalePct?: number | null;
  ageText?: string | null;
  ages?: AudienceBucket[];
  regionText?: string | null;
  hobbyText?: string | null;
  honorText?: string | null;
  honors?: AudienceBucket[];
  commentText?: string | null;
  fansText?: string | null;
  nonFanPct?: number | null;
  fanPct?: number | null;
  fetchedAt?: number | null;
};

/** 画像三切片：全部 / 付费 / 粉丝 */
export type PortraitSlices = {
  all?: AudiencePortrait | null;
  paid?: AudiencePortrait | null;
  fans?: AudiencePortrait | null;
};

/** 流失 / 高价值名单摘要（非完整 PII） */
export type AudienceMaintenance = {
  lostCount?: number | null;
  highValueCount?: number | null;
  lostSamples?: string[] | null;
  highValueSamples?: string[] | null;
  note?: string | null;
  fetchedAt?: number | null;
};

/** 复盘流量渠道（entrance_v2） */
export type TrafficChannel = {
  name: string;
  watchPct: number | null;
  consumePct?: number | null;
  avgWatchSec?: number | null;
};

/** 复盘转化漏斗（common_traffic_conversion，对齐抖音「全部流量转化」） */
export type TrafficFunnel = {
  showUcnt?: number | null;
  enterUcnt?: number | null;
  interactUcnt?: number | null;
  payUcnt?: number | null;
  followUcnt?: number | null;
  /** 进房/曝光 % */
  enterRate?: number | null;
  /** 互动/进房 % */
  interactRate?: number | null;
  /** 付费/进房 % */
  payRate?: number | null;
  /** 涨粉/进房 % */
  followRate?: number | null;
  enterRateDiff?: number | null;
  interactRateDiff?: number | null;
  payRateDiff?: number | null;
  followRateDiff?: number | null;
};

/** 复盘分钟趋势（minute_trend） */
export type MinutePoint = {
  t: string;
  viewers: number;
  watch?: number;
  gifts: number;
  followers: number;
  leave?: number;
  likes?: number;
  comments?: number;
};

export type LiveSession = {
  id: string;
  date: string;
  startTime: number;
  endTime: number | null;
  duration: number;
  title: string;
  type: string;
  peakViewers: number;
  avgViewers: number;
  totalGifts: number;
  giftSenders: number;
  newFollowers: number;
  newFansClub: number;
  totalComments: number;
  totalLikes: number;
  totalShares: number;
  dataPoints: LiveDataPoint[];
  audiencePortrait?: AudiencePortrait | null;
  portraitSlices?: PortraitSlices | null;
  audienceMaintenance?: AudienceMaintenance | null;
  trafficChannels?: TrafficChannel[] | null;
  trafficFunnel?: TrafficFunnel | null;
  minuteTrend?: MinutePoint[] | null;
} & LiveSessionDeep;

export type LiveGoals = {
  dailyGifts?: number;
  weeklyFollowers?: number;
  weeklyDurationSec?: number;
};

export type LiveScrapeResult = {
  liveStatus?: LiveStatus | string;
  needLogin?: boolean;
  title?: string | null;
  viewers?: number | null;
  gifts?: number | null;
  giftSenders?: number | null;
  newFollowers?: number | null;
  newFansClub?: number | null;
  comments?: number | null;
  likes?: number | null;
  shares?: number | null;
  error?: string;
};

/** 主播主页资料（头像 / 获赞 / 关注 / 粉丝） */
export type LiveProfile = {
  nickname: string;
  avatarUrl: string | null;
  diggCount: number | null;
  followingCount: number | null;
  followerCount: number | null;
  updatedAt?: number | null;
};

export type LiveStoreData = {
  loggedIn: boolean;
  sessions: LiveSession[];
  activeSessionId: string | null;
  goals?: LiveGoals;
  profile?: LiveProfile | null;
  /** unix 秒：上次成功拉历史列表的时间；用于进模块跳过全量重采 */
  lastHistorySyncAt?: number | null;
};
