function createElement(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1"
      || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/u.test(host)) return "";
    if (/^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(host)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function appendEvidenceGroup(documentRef, parent, title, items, translate) {
  const group = createElement(documentRef, "div", "evidence-group");
  group.append(createElement(documentRef, "h5", "", title));
  if (!items?.length) {
    group.append(createElement(documentRef, "p", "empty-evidence", translate("noEvidence")));
    parent.append(group);
    return;
  }

  const list = createElement(documentRef, "div", "evidence-list");
  for (const item of items) {
    const card = createElement(documentRef, "article", "evidence-card");
    const copy = createElement(documentRef, "div");
    const source = createElement(documentRef, "div", "evidence-source");
    source.append(createElement(documentRef, "span", "", item.source || translate("unknown")));
    source.append(createElement(
      documentRef,
      "span",
      "source-grade",
      `${translate("sourceGrade")} ${item.sourceEvaluation?.grade || "?"}`,
    ));
    if (item.publishedAt) source.append(createElement(documentRef, "span", "", `${translate("publishedAt")}: ${item.publishedAt}`));
    copy.append(source);
    copy.append(createElement(documentRef, "h6", "", item.title));
    copy.append(createElement(documentRef, "p", "", item.reason));
    card.append(copy);

    const href = safeExternalUrl(item.url);
    if (href) {
      const link = createElement(documentRef, "a", "source-link", translate("openSource"));
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    list.append(card);
  }
  group.append(list);
  parent.append(group);
}

function appendLimitations(documentRef, parent, items, translate) {
  const list = createElement(documentRef, "ul", "limitation-list");
  const values = Array.isArray(items) && items.length ? items : [translate("noLimitations")];
  for (const item of values) list.append(createElement(documentRef, "li", "", item));
  parent.append(list);
}

function scoreColor(score) {
  if (score >= 80) return "var(--verify-green)";
  if (score >= 60) return "var(--brand)";
  if (score >= 40) return "var(--verify-amber)";
  return "var(--verify-red)";
}

function localizedScoreLabel(score, outcome, translate) {
  if (!Number.isFinite(score)) return outcome === "insufficient_input"
    ? translate("scoreUncertain") : translate("noClaims");
  if (score >= 80) return translate("scoreHigh");
  if (score >= 60) return translate("scoreLikely");
  if (score >= 40) return translate("scoreUncertain");
  if (score >= 20) return translate("scoreUnlikely");
  return translate("scoreLow");
}

function renderScore(documentRef, report, translate) {
  const card = createElement(documentRef, "section", "score-card card");
  const ring = createElement(documentRef, "div", "score-ring");
  const numericScore = Number.isFinite(report.overallScore) ? report.overallScore : 0;
  ring.style.setProperty("--score", String(numericScore));
  ring.style.setProperty("--score-color", scoreColor(numericScore));
  ring.setAttribute("aria-label", `${translate("credibility")} ${Number.isFinite(report.overallScore) ? report.overallScore : translate("unknown")} ${translate("scoreUnit")}`);
  const score = createElement(documentRef, "div", "score-value");
  score.append(createElement(documentRef, "strong", "", Number.isFinite(report.overallScore) ? report.overallScore : "—"));
  score.append(createElement(documentRef, "span", "", translate("scoreUnit")));
  ring.append(score);

  const copy = createElement(documentRef, "div", "score-copy");
  copy.append(createElement(documentRef, "span", "score-label", localizedScoreLabel(report.overallScore, report.outcome, translate)));
  copy.append(createElement(documentRef, "h3", "", translate("conclusion")));
  copy.append(createElement(documentRef, "p", "", report.summary));
  card.append(ring, copy);
  return card;
}

function renderClaims(documentRef, report, translate) {
  const section = createElement(documentRef, "section", "report-section card");
  section.append(createElement(documentRef, "h3", "", translate("claims")));
  if (!report.claims?.length) {
    section.append(createElement(documentRef, "p", "empty-evidence", translate("noClaims")));
    return section;
  }

  report.claims.forEach((claim, index) => {
    const card = createElement(documentRef, "article", "claim-card");
    const head = createElement(documentRef, "div", "claim-head");
    const title = createElement(documentRef, "div");
    title.append(createElement(documentRef, "span", "claim-index", `${translate("claim").toUpperCase()} ${index + 1}`));
    title.append(createElement(documentRef, "h4", "", claim.claim));
    head.append(title, createElement(documentRef, "span", "verdict-badge", translate(`verdict_${claim.verdict}`)));
    card.append(head);
    card.append(createElement(documentRef, "p", "claim-reason", claim.reason));
    card.append(createElement(
      documentRef,
      "p",
      "claim-score",
      `${translate("credibility")} ${claim.credibilityScore} / 100 · ${translate("evidenceScore")} ${Number(claim.confidence || 0).toFixed(2)}`,
    ));
    appendEvidenceGroup(documentRef, card, translate("supporting"), claim.supporting_evidence, translate);
    appendEvidenceGroup(documentRef, card, translate("contradicting"), claim.contradicting_evidence, translate);
    if (claim.limitations?.length) {
      const group = createElement(documentRef, "div", "evidence-group");
      group.append(createElement(documentRef, "h5", "", translate("limitations")));
      appendLimitations(documentRef, group, claim.limitations, translate);
      card.append(group);
    }
    section.append(card);
  });
  return section;
}

function renderProcess(documentRef, report, translate) {
  const section = createElement(documentRef, "section", "report-section card");
  const details = createElement(documentRef, "details", "process-details");
  details.append(createElement(documentRef, "summary", "", translate("process")));
  const grid = createElement(documentRef, "div", "process-grid");
  const metrics = [
    [report.process?.claimsExtracted || 0, translate("extractedClaims")],
    [report.process?.queriesRun || 0, translate("queriesRun")],
    [report.process?.pagesFound || 0, translate("pagesFound")],
    [report.process?.duplicatesRemoved || 0, translate("duplicatesRemoved")],
  ];
  for (const [value, label] of metrics) {
    const metric = createElement(documentRef, "div", "process-metric");
    metric.append(createElement(documentRef, "strong", "", value), createElement(documentRef, "span", "", label));
    grid.append(metric);
  }
  details.append(grid);
  details.append(createElement(documentRef, "p", "claim-score", `${translate("provider")}: ${report.process?.provider || translate("unknown")}`));
  if (report.searches?.length) {
    const list = createElement(documentRef, "ul", "query-list");
    for (const search of report.searches) {
      list.append(createElement(documentRef, "li", "", `${search.query} · ${search.resultCount}`));
    }
    details.append(createElement(documentRef, "h4", "", translate("queries")), list);
  }
  if (report.inputMetadata) {
    details.append(createElement(documentRef, "h4", "", translate("metadata")));
    const metadata = report.inputMetadata;
    const value = [metadata.fileName, metadata.mimeType, `${metadata.size} bytes`, metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : ""]
      .filter(Boolean).join(" · ");
    details.append(createElement(documentRef, "p", "claim-score", value));
  }
  section.append(details);
  return section;
}

export function renderReport(root, report, translate, documentRef = document) {
  root.replaceChildren();
  root.append(renderScore(documentRef, report, translate));
  root.append(renderClaims(documentRef, report, translate));

  const limits = createElement(documentRef, "section", "report-section card");
  limits.append(createElement(documentRef, "h3", "", translate("limitations")));
  appendLimitations(documentRef, limits, report.limitations, translate);
  root.append(limits);

  const detector = createElement(documentRef, "section", "report-section card");
  detector.append(createElement(documentRef, "h3", "", translate("aiDetection")));
  detector.append(createElement(documentRef, "p", "detector-status", translate("detectorUnavailable")));
  root.append(detector, renderProcess(documentRef, report, translate));
}

export { safeExternalUrl };
