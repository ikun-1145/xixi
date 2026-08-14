const MAINSTREAM = new Map([
  ["reuters.com", "Reuters"],
  ["apnews.com", "AP"],
  ["bbc.com", "BBC"],
  ["bbc.co.uk", "BBC"],
  ["xinhuanet.com", "新华社"],
  ["news.cn", "新华社"],
  ["nhk.or.jp", "NHK"],
]);

const COMMUNITY_HOSTS = [
  "reddit.com", "quora.com", "zhihu.com", "weibo.com", "x.com", "twitter.com",
  "facebook.com", "instagram.com", "tiktok.com", "youtube.com", "bilibili.com",
  "medium.com", "wordpress.com", "blogspot.com", "tieba.baidu.com",
];

function matchesHost(hostname, candidate) {
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

function looksLikeSubjectHost(hostname, subject) {
  const subjectTokens = String(subject || "").toLowerCase().match(/[a-z0-9]{3,}/gu) || [];
  const hostLabel = hostname.split(".").at(-2) || "";
  return subjectTokens.some(token => hostLabel === token || hostLabel.startsWith(token) || token.startsWith(hostLabel));
}

export function evaluateSource(result, context = {}) {
  let hostname = "";
  try {
    hostname = new URL(result?.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { grade: "D", reason: "来源地址无效，无法评估。", isOriginalCandidate: false };
  }

  if (/\.(gov|gov\.[a-z]{2}|edu|edu\.[a-z]{2})$/i.test(hostname)
    || /(^|\.)(who|un|europa)\.int$/i.test(hostname)) {
    return {
      grade: "A",
      reason: "政府、公共机构或学术机构域名；仍需核对页面是否为原始材料。",
      isOriginalCandidate: true,
    };
  }

  for (const [domain, name] of MAINSTREAM) {
    if (matchesHost(hostname, domain)) {
      return {
        grade: "B",
        reason: `${name} 等具有编辑制度的主流媒体；评级仅表示来源类型。`,
        isOriginalCandidate: false,
      };
    }
  }

  if (looksLikeSubjectHost(hostname, context.subject)) {
    return {
      grade: "A",
      reason: "域名与声明主体一致，可能是企业或原始发布者；仍需核对页面归属与内容。",
      isOriginalCandidate: true,
    };
  }

  if (COMMUNITY_HOSTS.some((domain) => matchesHost(hostname, domain))
    || /(^|\.)(blog|forum|bbs)\./i.test(hostname)) {
    return {
      grade: "D",
      reason: "社交平台、论坛或个人发布渠道，需要独立来源交叉验证。",
      isOriginalCandidate: false,
    };
  }

  return {
    grade: "C",
    reason: "一般资讯或行业网站，是否具有编辑制度需结合页面进一步判断。",
    isOriginalCandidate: false,
  };
}

export function attachSourceEvaluation(results, context = {}) {
  return results.map((result) => ({ ...result, sourceEvaluation: evaluateSource(result, context) }));
}

export function countIndependentSources(evidence) {
  const hosts = new Set();
  for (const item of evidence || []) {
    try {
      hosts.add(new URL(item.url).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      // 已由入口校验；异常项不计为独立来源。
    }
  }
  return hosts.size;
}
