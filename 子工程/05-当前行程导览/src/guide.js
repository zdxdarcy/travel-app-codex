import { guideClient, GuideError } from "./repository.js?v=20260812";

const state = {
  snapshot: null,
  view: "overview",
  selectedDayId: null,
  loading: true,
  error: null,
  busy: new Set(),
  pollTimer: null
};

let detailScrollCleanup = () => {};
let detailSyncFrame = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const statusLabels = { not_started: "未开始", completed: "已完成", skipped: "已跳过" };
const modeLabels = { inside: "入内", outside: "外部", none: "不安排" };

function isDetailItem(item) {
  // Every normalized trip item belongs in the ordered card stream. Keeping a
  // single predicate here prevents newly introduced logistics/custom kinds
  // from silently falling into a trailing timeline at the end of the day.
  return Boolean(item?.id);
}

function dateLabel(value, withYear = false) {
  if (!value) return "日期待定";
  return new Intl.DateTimeFormat("zh-CN", withYear ? { year: "numeric", month: "long", day: "numeric" } : { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function showToast(message, tone = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setSync(stateName, label) {
  $("#syncState").dataset.state = stateName;
  $("#syncText").textContent = label;
}

function setRoute(view, dayId = null, itemId = null) {
  const params = new URLSearchParams(location.search);
  if ((view === "day" || view === "detail") && dayId) params.set("dayId", dayId);
  else params.delete("dayId");
  if (view === "detail" && itemId) params.set("itemId", itemId);
  else params.delete("itemId");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
  state.view = view;
  state.selectedDayId = dayId;
  render();
}

function hashItemId() {
  const rawHash = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  if (!rawHash) return null;
  const hashParams = new URLSearchParams(rawHash);
  const parameterId = hashParams.get("itemId") || hashParams.get("attractionId");
  if (parameterId) return parameterId;
  return rawHash.replace(/^(?:item|attraction)[-_:/=]/i, "");
}

function requestedItemId() {
  return new URLSearchParams(location.search).get("itemId") || hashItemId();
}

function routeFromLocation() {
  const params = new URLSearchParams(location.search);
  const dayId = params.get("dayId");
  const itemId = requestedItemId();
  const validDay = state.snapshot?.days.find((day) => day.id === dayId);
  const itemDay = itemId ? state.snapshot?.days.find((day) => day.items.some((item) => isDetailItem(item) && item.id === itemId)) : null;
  const activeDay = validDay || itemDay;
  if (activeDay) {
    state.selectedDayId = activeDay.id;
    const validItem = activeDay.items.find((item) => isDetailItem(item) && item.id === itemId);
    state.view = validItem ? "detail" : "day";
    if (!validItem && itemId) {
      params.delete("itemId");
      history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}`);
    } else if (validItem && params.get("dayId") !== activeDay.id) {
      params.set("dayId", activeDay.id);
      params.set("itemId", validItem.id);
      history.replaceState(null, "", `${location.pathname}?${params}`);
    }
  } else {
    state.view = "overview";
    state.selectedDayId = null;
    if (dayId || itemId) history.replaceState(null, "", location.pathname);
  }
}

function progressFor(day) {
  const progressItems = day.items.filter((item) => !item.displayOnly);
  const total = progressItems.length;
  const done = progressItems.filter((item) => item.state.status === "completed" || item.state.status === "skipped").length;
  return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
}

function sanitizeNoteHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  const output = document.createElement("div");
  const copy = (node, parent) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.nodeValue));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.tagName === "BR") { parent.appendChild(document.createElement("br")); return; }
      if (child.tagName !== "SPAN") { copy(child, parent); return; }
      const span = document.createElement("span");
      const color = child.style.backgroundColor;
      if (/^(#|rgb|rgba|hsl|hsla)/i.test(color || "")) span.style.backgroundColor = color;
      copy(child, span);
      parent.appendChild(span);
    });
  };
  copy(template.content, output);
  return output.innerHTML;
}

function render() {
  const app = $("#app");
  if (state.loading) {
    app.innerHTML = '<section class="loading-panel"><span class="loader" aria-hidden="true"></span><p>正在读取当前行程</p></section>';
    return;
  }
  if (state.error) {
    app.innerHTML = `<section class="empty-panel error-panel"><span class="panel-icon" aria-hidden="true">!</span><div><p class="eyebrow">GUIDE ERROR</p><h1>当前行程暂时无法打开</h1><p>${escapeHtml(state.error.message)}</p></div><button class="primary-button" type="button" data-action="refresh">重新读取</button></section>`;
    return;
  }
  if (!state.snapshot) {
    app.innerHTML = emptyView();
    return;
  }
  routeFromLocation();
  app.innerHTML = `${tripHeader()}${viewTabs()}${state.view === "overview" ? overviewView() : state.view === "detail" ? detailView() : dayView()}`;
  bindDetailInteractions();
  if (state.view === "detail") requestAnimationFrame(() => {
    const itemId = requestedItemId();
    const card = itemId ? $(`[data-detail-card="${CSS.escape(itemId)}"]`) : null;
    if (card) scrollToDetailCard(card, { behavior: "instant", updateRoute: false });
    syncDetailSelection();
  });
}

function emptyView() {
  return '<section class="empty-panel"><span class="panel-icon" aria-hidden="true">◷</span><div><p class="eyebrow">ON THE ROAD</p><h1>还没有当前行程</h1><p>在规划器中保存行程并设为当前行程后，这里会显示按天导览。</p></div><a class="secondary-button" href="../04-旅程规划/planner.html?newTrip=1">打开行程规划</a></section>';
}

function tripHeader() {
  const trip = state.snapshot.trip;
  const dayCount = state.snapshot.days.length;
  const locations = [trip.departLocation, trip.returnLocation].filter(Boolean).map(escapeHtml).join(" → ");
  return `<section class="trip-hero"><div><p class="eyebrow">CURRENT TRIP</p><h1>${escapeHtml(trip.title)}</h1><p class="trip-period">${escapeHtml(dateLabel(trip.departDate, true))} — ${escapeHtml(dateLabel(trip.returnDate, true))}</p></div><div class="trip-facts"><div><strong>${dayCount}</strong><span>天</span></div><div><strong>${state.snapshot.days.reduce((sum, day) => sum + day.items.length, 0)}</strong><span>项安排</span></div>${locations ? `<p>${locations}</p>` : ""}</div></section>`;
}

function viewTabs() {
  const daySelected = state.view === "day" || state.view === "detail";
  return `<nav class="day-tabs" aria-label="行程日期"><div class="day-tabs-scroll"><button type="button" class="day-tab home ${state.view === "overview" ? "is-active" : ""}" data-view="overview">总览</button><span class="day-tab-separator"></span>${state.snapshot.days.map((day) => `<button type="button" class="day-tab ${daySelected && state.selectedDayId === day.id ? "is-active" : ""}" data-day="${escapeHtml(day.id)}">D${day.sequence}</button>`).join("")}</div></nav>`;
}

function dayNav() {
  return `<nav class="day-nav" aria-label="选择行程日"><div class="day-nav-scroll">${state.snapshot.days.map((day) => {
    const progress = progressFor(day);
    const active = state.selectedDayId === day.id;
    return `<button type="button" class="day-chip ${active ? "is-active" : ""}" data-day="${escapeHtml(day.id)}" aria-current="${active ? "page" : "false"}"><span>D${day.sequence}</span><small>${escapeHtml(dateLabel(day.date))}</small><em>${progress.done}/${progress.total}</em></button>`;
  }).join("")}</div></nav>`;
}

function overviewView() {
  const days = state.snapshot.days;
  return `<section class="content-section"><div class="section-heading compact-heading"><div><p class="eyebrow">ITINERARY OVERVIEW</p><h2>接下来的每一天</h2><p class="lede">按计划顺序查看安排，执行状态会单独记录。</p></div><span class="heading-index">${String(days.length).padStart(2, "0")}</span></div><div class="day-grid">${days.map(dayCard).join("")}</div></section>`;
}

function dayCard(day) {
  const progress = progressFor(day);
  const cityNames = day.cities.map((city) => city.name).join(" · ") || "城市待定";
  const preview = day.items.slice(0, 3).map((item) => escapeHtml(item.nameSnapshot)).join("、") || "暂无安排";
  const hotel = day.accommodation?.label || "住宿待定";
  return `<article class="day-card"><button class="day-card-main" type="button" data-day="${escapeHtml(day.id)}"><span class="day-number">D${day.sequence}</span><span class="day-card-copy"><strong>${escapeHtml(dateLabel(day.date, true))}</strong><span>${escapeHtml(day.weekday || "")}${cityNames ? ` · ${escapeHtml(cityNames)}` : ""}</span><small>${preview}</small></span><span class="day-card-arrow" aria-hidden="true">↗</span></button><div class="day-card-meta"><span>${escapeHtml(hotel)}</span><span>${progress.done}/${progress.total} 完成</span></div><div class="progress"><span style="width:${progress.percent}%"></span></div></article>`;
}

function dayView() {
  const day = state.snapshot.days.find((item) => item.id === state.selectedDayId) || state.snapshot.days[0];
  if (!day) return '<section class="empty-panel"><h1>行程暂无日程</h1></section>';
  const progress = progressFor(day);
  const cities = day.cities.map((city) => city.name).join(" · ") || "城市待定";
  const detailItems = day.items.filter(isDetailItem);
  const selectedId = requestedItemId();
  const selectedIndex = Math.max(0, detailItems.findIndex((item) => item.id === selectedId));
  const chips = detailItems.map((item, index) => `<button type="button" class="attraction-chip ${index === selectedIndex ? "is-active" : ""}" data-detail-chip="${escapeHtml(item.id)}"><span>${index + 1}</span>${escapeHtml(item.details?.name || item.nameSnapshot)}</button>`).join("");
  const content = detailItems.length
    ? `<nav class="attraction-nav" aria-label="当天安排"><div class="attraction-nav-scroll">${chips}</div></nav><div class="guide-detail-deck" data-detail-deck>${detailItems.map((item, index) => detailItemCard(item, day, index, index === selectedIndex)).join("")}</div>`
    : '<div class="quiet-panel">这一天还没有安排。</div>';
  return `<section class="content-section day-view"><div class="day-toolbar"><div><p class="eyebrow">DAY ${String(day.sequence).padStart(2, "0")}</p><h2>${escapeHtml(dateLabel(day.date, true))}</h2><p class="lede">${escapeHtml(day.weekday || "")} · ${escapeHtml(cities)}</p></div><div class="day-progress"><strong>${progress.done}/${progress.total}</strong><span>已处理</span></div></div>${content}</section>`;
}

function detailView() {
  return dayView();
}

function dayMeta(day) {
  const mealEntries = Object.entries(day.meals || {}).filter(([, value]) => value && value !== "—" && value !== "-");
  const blocks = [];
  if (mealEntries.length) blocks.push(`<div class="meta-block"><span class="meta-label">餐饮</span><p>${mealEntries.map(([key, value]) => `${escapeHtml(key)}：${escapeHtml(value)}`).join(" · ")}</p></div>`);
  return blocks.length ? `<aside class="day-meta">${blocks.join("")}</aside>` : "";
}

function coordinateQuery(source) {
  const coordinates = source?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) return `${coordinates[0]},${coordinates[1]}`;
  if (coordinates && typeof coordinates === "object") {
    const latitude = coordinates.latitude ?? coordinates.lat;
    const longitude = coordinates.longitude ?? coordinates.lng;
    if (latitude != null && longitude != null) return `${latitude},${longitude}`;
  }
  const latitude = source?.latitude ?? source?.lat;
  const longitude = source?.longitude ?? source?.lng;
  return latitude != null && longitude != null ? `${latitude},${longitude}` : null;
}

function safeMapUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function mapTarget(item) {
  const details = item.details || {};
  const logistics = item.logistics || {};
  const metadata = item.metadata || {};
  const directUrl = safeMapUrl(details.mapUrl || logistics.mapUrl || metadata.map_url || metadata.mapUrl);
  const query = details.mapQuery || logistics.mapQuery || metadata.map_query || metadata.mapQuery || coordinateQuery(details) || coordinateQuery(logistics) || coordinateQuery(metadata);
  return directUrl ? { href: directUrl, query } : query ? { href: guideClient.externalMapUrl(query), query } : null;
}

function googleMapsIcon() {
  return '<img class="google-maps-icon" src="../06-用户与PWA/assets/google-maps.svg" alt="" aria-hidden="true">';
}

function mapQuickLink(item, title) {
  const target = mapTarget(item);
  if (!target) return "";
  return `<a class="map-quick-link" href="${escapeHtml(target.href)}" target="_blank" rel="noreferrer" aria-label="在地图中打开${escapeHtml(title)}" title="在地图中打开${escapeHtml(title)}">${googleMapsIcon()}<span class="sr-only">地图</span></a>`;
}

function mapActions(item, target) {
  if (!target) return "";
  const preview = target.query ? `<button class="secondary-button small" type="button" data-map-preview="${escapeHtml(item.id)}" aria-expanded="false">预览地图</button>` : "";
  const container = target.query ? `<div class="map-preview" data-map-container="${escapeHtml(item.id)}"></div>` : "";
  return `<div class="map-actions"><a class="text-button small" href="${escapeHtml(target.href)}" target="_blank" rel="noreferrer">打开地图 ↗</a>${preview}</div>${container}`;
}

function itemCard(item) {
  const isPlace = item.kind === "place";
  const title = item.details?.name || item.nameSnapshot;
  const location = item.cityName ? `<span class="item-city">${escapeHtml(item.cityName)}</span>` : "";
  const plan = isPlace ? `<span class="mode-chip mode-${item.visitMode}">计划 · ${modeLabels[item.visitMode]}</span>` : `<span class="mode-chip mode-neutral">${escapeHtml(item.logistics?.label || item.meal?.mealType || "自定义安排")}</span>`;
  const missing = isPlace && !item.details ? '<p class="missing-note">目录资料暂不可用，仍保留行程中的名称和地图入口。</p>' : "";
  const details = isPlace && item.details ? placeDetails(item.details) : logisticsDetails(item);
  const target = mapTarget(item);
  const actions = mapActions(item, target);
  const busy = state.busy.has(item.id);
  const titleHtml = isPlace ? `<button class="item-title-button" type="button" data-detail-item="${escapeHtml(item.id)}" aria-label="查看${escapeHtml(title)}详情">${escapeHtml(title)}</button>` : `<h3>${escapeHtml(title)}</h3>`;
  const execution = item.displayOnly ? "" : `<div class="execution"><span class="execution-label">实际状态</span><div class="status-actions" role="group" aria-label="${escapeHtml(title)}实际状态">${statusButton(item, "not_started", "○")}${statusButton(item, "completed", "✓")}${statusButton(item, "skipped", "—")}</div></div>`;
  return `<article class="item-card item-${item.kind} ${item.state.status !== "not_started" ? `status-${item.state.status}` : ""} ${busy ? "is-syncing" : ""}" data-item-card="${escapeHtml(item.id)}"><div class="item-rail"><span class="item-order">${item.displayOnly ? "⌂" : item.plannedOrder}</span><span class="rail-line"></span></div><div class="item-body"><div class="item-heading"><div><div class="item-kicker">${location}${plan}</div>${titleHtml}${item.details?.nameEn ? `<p class="item-en">${escapeHtml(item.details.nameEn)}</p>` : ""}</div><span class="status-pill status-${item.state.status}">${statusLabels[item.state.status]}</span></div>${missing}${details}${actions}${execution}</div></article>`;
}

function detailItemCard(item, day, index, selected) {
  const isPlace = item.kind === "place";
  const title = item.details?.name || item.nameSnapshot;
  const location = item.cityName ? `<span class="item-city">${escapeHtml(item.cityName)}</span>` : "";
  const plan = isPlace ? `<span class="mode-chip mode-${item.visitMode}">计划 · ${modeLabels[item.visitMode]}</span>` : `<span class="mode-chip mode-neutral">${escapeHtml(item.logistics?.label || item.meal?.mealType || "自定义安排")}</span>`;
  const missing = isPlace && !item.details ? '<p class="missing-note">目录资料暂不可用，仍保留行程中的名称和地图入口。</p>' : "";
  const details = isPlace ? (item.details ? detailPlaceDetails(item.details) : missing) : logisticsDetails(item);
  const target = mapTarget(item);
  const actions = mapActions(item, target);
  const titleRow = `<div class="detail-title-row"><h3>${escapeHtml(title)}</h3>${mapQuickLink(item, title)}</div>`;
  return `<article class="guide-detail-card ${selected ? "is-selected" : ""}" id="item-${escapeHtml(item.id)}" data-detail-card="${escapeHtml(item.id)}"><div class="detail-card-heading"><div class="detail-card-heading-main"><div class="item-kicker"><span class="detail-order">${index + 1}</span>${location}${plan}</div>${titleRow}${item.details?.nameEn ? `<p class="item-en">${escapeHtml(item.details.nameEn)}</p>` : ""}</div><span class="status-pill status-${item.state.status}">${statusLabels[item.state.status]}</span></div>${noteEditor(item)}${details}${actions}<div class="execution"><span class="execution-label">实际状态</span><div class="status-actions" role="group" aria-label="${escapeHtml(title)}实际状态">${statusButton(item, "not_started", "○")}${statusButton(item, "completed", "✓")}${statusButton(item, "skipped", "—")}</div></div></article>`;
}

function detailPlaceDetails(details) {
  const facts = [
    details.duration ? `<span><b>建议时长</b>${escapeHtml(details.duration)}</span>` : "",
    details.hours ? `<span><b>开放时间</b>${escapeHtml(details.hours)}</span>` : "",
    details.price ? `<span><b>票价</b>${escapeHtml(details.price)}</span>` : "",
    details.rating != null ? `<span><b>评价</b>${details.rating.toFixed(1)} / 5${details.reviewCount != null ? ` · ${details.reviewCount} 条` : ""}</span>` : ""
  ].filter(Boolean).join("");
  const photos = details.photos.length ? `<div class="photo-strip detail-photo-strip">${details.photos.map((photo, index) => `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.alt)}" loading="${index === 0 ? "eager" : "lazy"}" decoding="async">`).join("")}</div>` : "";
  const reviews = renderReviewSummary(details.reviewSummaries, 5);
  return `${details.intro ? `<p class="item-intro detail-intro">${escapeHtml(details.intro)}</p>` : ""}${photos}${facts ? `<div class="fact-row detail-facts">${facts}</div>` : ""}${details.tips ? `<p class="tips"><b>实用贴士</b>${escapeHtml(details.tips)}</p>` : ""}${reviews}`;
}

function noteEditor(item) {
  const value = sanitizeNoteHtml(item.state.actualNote || "");
  const empty = value ? "" : " empty";
  const colors = ["#fff3a3", "#ffd6e7", "#b9f6ca", "#e1bee7", "#cfe0ff", "#ffd6c2"];
  return `<div class="note-editor" data-note-editor="${escapeHtml(item.id)}"><div class="note-editor-head"><label>我的标注</label><button class="text-button small" type="button" data-edit-note="${escapeHtml(item.id)}">编辑</button></div><div class="note-view${empty}" data-note-view>${value || '<span class="note-placeholder">还没有标注</span>'}</div><div class="note-edit" data-note-edit hidden><div class="note-tools" aria-label="标注高亮颜色">${colors.map((color) => `<button type="button" class="note-color" data-note-color="${color}" style="background:${color}" aria-label="使用高亮颜色"></button>`).join("")}</div><div class="note-input" contenteditable="true" role="textbox" aria-label="${escapeHtml(item.nameSnapshot)} 的标注" data-note-input="${escapeHtml(item.id)}" data-ph="记录入口、排队、停车或现场感受">${value}</div><div class="note-actions"><button class="secondary-button small" type="button" data-cancel-note="${escapeHtml(item.id)}">取消</button><button class="primary-button small" type="button" data-save-note="${escapeHtml(item.id)}">保存</button></div></div></div>`;
}

function renderReviewSummary(reviews, limit = 5) {
  const entries = (reviews || []).slice(0, limit);
  if (!entries.length) return "";
  const labels = ["好评", "好评", "中评", "差评", "差评"];
  const classes = ["good", "good", "neutral", "bad", "bad"];
  return `<div class="review-summary"><span class="meta-label">评价摘要</span><div class="review-list">${entries.map((review, index) => `<div class="review-entry review-${classes[index] || "neutral"}"><span class="review-label">${labels[index] || "评价"}</span><p>${escapeHtml(review.review_text)}</p></div>`).join("")}</div></div>`;
}

function statusButton(item, status, icon) {
  return `<button type="button" class="status-button ${item.state.status === status ? "is-active" : ""}" data-status="${status}" data-item-id="${escapeHtml(item.id)}" ${state.busy.has(item.id) ? "disabled" : ""}><span aria-hidden="true">${icon}</span>${statusLabels[status]}</button>`;
}

function placeDetails(details) {
  const facts = [
    details.duration ? `<span><b>时长</b>${escapeHtml(details.duration)}</span>` : "",
    details.hours ? `<span><b>开放</b>${escapeHtml(details.hours)}</span>` : "",
    details.price ? `<span><b>票价</b>${escapeHtml(details.price)}</span>` : "",
    details.rating != null ? `<span><b>评价</b>${details.rating.toFixed(1)} / 5${details.reviewCount != null ? ` · ${details.reviewCount} 条` : ""}</span>` : ""
  ].filter(Boolean).join("");
  const photos = details.photos.length ? `<div class="photo-strip">${details.photos.map((photo) => `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.alt)}" loading="lazy">`).join("")}</div>` : "";
  const reviews = renderReviewSummary(details.reviewSummaries, 5);
  return `<div class="place-content">${details.intro ? `<p class="item-intro">${escapeHtml(details.intro)}</p>` : ""}${photos}${facts ? `<div class="fact-row">${facts}</div>` : ""}${details.tips ? `<p class="tips"><b>提示</b>${escapeHtml(details.tips)}</p>` : ""}${reviews}</div>`;
}

function detailTopOffset() {
  const topbar = $(".topbar");
  return (topbar?.getBoundingClientRect().bottom || 0) + 16;
}

function updateDetailRoute(itemId) {
  const params = new URLSearchParams(location.search);
  if (state.selectedDayId) params.set("dayId", state.selectedDayId);
  if (itemId) params.set("itemId", itemId);
  else params.delete("itemId");
  history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}`);
}

function syncDetailSelection() {
  const deck = $("[data-detail-deck]");
  if (!deck) return;
  const cards = [...deck.querySelectorAll("[data-detail-card]")];
  if (!cards.length) return;
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  let index;
  if (mobile) {
    index = Math.max(0, Math.min(cards.length - 1, Math.round(deck.scrollLeft / Math.max(deck.clientWidth, 1))));
  } else {
    const line = detailTopOffset() + 18;
    index = cards.reduce((best, card, candidate) => {
      const bestDistance = Math.abs(cards[best].getBoundingClientRect().top - line);
      const candidateDistance = Math.abs(card.getBoundingClientRect().top - line);
      return candidateDistance < bestDistance ? candidate : best;
    }, 0);
  }
  const itemId = cards[index].dataset.detailCard;
  cards.forEach((card, cardIndex) => card.classList.toggle("is-selected", cardIndex === index));
  document.querySelectorAll("[data-detail-chip]").forEach((chip) => {
    const active = chip.dataset.detailChip === itemId;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-current", active ? "true" : "false");
    if (active) {
      const nav = chip.closest(".attraction-nav-scroll");
      if (nav) nav.scrollTo({ left: Math.max(0, chip.offsetLeft - nav.clientWidth / 2 + chip.offsetWidth / 2), behavior: "smooth" });
    }
  });
  if (requestedItemId() !== itemId) updateDetailRoute(itemId);
}

function bindDetailInteractions() {
  detailScrollCleanup();
  const deck = $("[data-detail-deck]");
  if (!deck) return;
  const schedule = () => {
    cancelAnimationFrame(detailSyncFrame);
    detailSyncFrame = requestAnimationFrame(syncDetailSelection);
  };
  deck.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  detailScrollCleanup = () => {
    deck.removeEventListener("scroll", schedule);
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    cancelAnimationFrame(detailSyncFrame);
  };
}

function scrollToDetailCard(card, { behavior = "smooth", updateRoute = true } = {}) {
  if (!card) return;
  const deck = card.closest("[data-detail-deck]");
  if (updateRoute) updateDetailRoute(card.dataset.detailCard);
  card.scrollIntoView({
    behavior: behavior === "instant" ? "auto" : behavior,
    block: "start",
    inline: "nearest"
  });
  if (deck && window.matchMedia("(max-width: 760px)").matches) {
    deck.scrollTo({ left: card.offsetLeft, behavior: behavior === "instant" ? "auto" : behavior });
  }
  requestAnimationFrame(() => {
    const correction = card.getBoundingClientRect().top - detailTopOffset();
    if (Math.abs(correction) > 1) window.scrollBy({ top: correction, behavior: "auto" });
  });
  requestAnimationFrame(syncDetailSelection);
}

function logisticsDetails(item) {
  const content = item.logistics?.note || item.meal?.note || item.metadata?.note || null;
  return content ? `<div class="logistics-content"><p>${escapeHtml(content)}</p></div>` : "";
}

async function load() {
  state.loading = true;
  state.error = null;
  setSync("loading", "正在读取");
  render();
  try {
    const result = await guideClient.loadActiveGuide();
    if (result.kind === "empty") {
      state.snapshot = null;
      state.emptyReason = result.reason;
      setSync(result.reason === "AUTH_REQUIRED" ? "offline" : "ready", result.reason === "AUTH_REQUIRED" ? "需要登录" : "无当前行程");
    } else {
      state.snapshot = result.snapshot;
      state.emptyReason = null;
      routeFromLocation();
      setSync("ready", "已同步");
      startPolling();
    }
  } catch (error) {
    state.snapshot = null;
    state.error = error instanceof GuideError ? error : new GuideError("NETWORK_OFFLINE", "读取当前行程失败。", error);
    setSync("error", "读取失败");
  } finally {
    state.loading = false;
    render();
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.hidden || state.busy.size) return;
    try {
      const result = await guideClient.loadActiveGuide();
      if (result.kind === "ready" && result.snapshot.trip.id === state.snapshot?.trip.id && result.snapshot.trip.revision !== state.snapshot.trip.revision) {
        state.snapshot = result.snapshot;
        routeFromLocation();
        render();
        setSync("ready", "已更新");
      }
    } catch { /* keep the last usable snapshot until an explicit refresh */ }
  }, 60_000);
}

async function saveStatus(itemId, status) {
  if (state.busy.has(itemId) || !state.snapshot) return;
  const item = findItem(itemId);
  if (!item || item.state.status === status) return;
  state.busy.add(itemId);
  render();
  try {
    item.state = await guideClient.updateItem(itemId, { status }, state.snapshot);
    showToast(status === "completed" ? "已标记完成" : status === "skipped" ? "已标记跳过" : "已恢复为未开始");
    setSync("ready", "已同步");
  } catch (error) {
    showToast(error.message || "状态保存失败", "error");
    setSync("error", "待重试");
  } finally {
    state.busy.delete(itemId);
    render();
  }
}

async function saveNote(itemId) {
  if (state.busy.has(itemId) || !state.snapshot) return;
  const item = findItem(itemId);
  const input = document.querySelector(`[data-note-input="${CSS.escape(itemId)}"]`);
  if (!item || !input) return;
  const noteValue = sanitizeNoteHtml(input.innerHTML);
  state.busy.add(itemId);
  render();
  try {
    item.state = await guideClient.updateItem(itemId, { actualNote: noteValue.trim() }, state.snapshot);
    showToast("实际备注已保存");
    setSync("ready", "已同步");
  } catch (error) {
    showToast(error.message || "备注保存失败", "error");
    setSync("error", "待重试");
  } finally {
    state.busy.delete(itemId);
    render();
  }
}

function findItem(itemId) {
  for (const day of state.snapshot?.days || []) {
    const item = day.items.find((entry) => entry.id === itemId);
    if (item) return item;
  }
  return null;
}

function loadMapPreview(itemId) {
  const item = findItem(itemId);
  const container = document.querySelector(`[data-map-container="${CSS.escape(itemId)}"]`);
  const card = document.querySelector(`[data-item-card="${CSS.escape(itemId)}"], [data-detail-card="${CSS.escape(itemId)}"]`);
  const query = mapTarget(item)?.query;
  if (!container || !query || container.querySelector("iframe")) return;
  const url = new URL("https://www.google.com/maps");
  url.searchParams.set("q", query);
  url.searchParams.set("output", "embed");
  const iframe = document.createElement("iframe");
  iframe.title = `${item.nameSnapshot} 地图预览`;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "no-referrer-when-downgrade";
  iframe.src = url.toString();
  container.replaceChildren(iframe);
  card?.querySelector("[data-map-preview]")?.setAttribute("aria-expanded", "true");
}

function applyNoteColor(colorButton) {
  const editor = colorButton?.closest("[data-note-editor]");
  const input = editor?.querySelector("[data-note-input]");
  if (!input) return;
  try { document.execCommand("styleWithCSS", false, true); } catch { /* browser default is fine */ }
  let applied = false;
  try { applied = document.execCommand("hiliteColor", false, colorButton.dataset.noteColor); } catch { /* use fallback below */ }
  if (!applied) {
    try { document.execCommand("backColor", false, colorButton.dataset.noteColor); } catch { /* unsupported browser */ }
  }
}

// Prevent the contenteditable selection from disappearing before the example's
// highlighter is applied to the selected text.
document.addEventListener("mousedown", (event) => {
  const colorButton = event.target.closest("[data-note-color]");
  if (!colorButton) return;
  event.preventDefault();
  applyNoteColor(colorButton);
});

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { setRoute(viewButton.dataset.view, viewButton.dataset.view === "day" ? (state.selectedDayId || state.snapshot?.days[0]?.id) : null); return; }
  const dayButton = event.target.closest("[data-day]");
  if (dayButton) { setRoute("day", dayButton.dataset.day); return; }
  const detailChip = event.target.closest("[data-detail-chip]");
  if (detailChip) {
    const card = document.querySelector(`[data-detail-card="${CSS.escape(detailChip.dataset.detailChip)}"]`);
    scrollToDetailCard(card, { behavior: "smooth", updateRoute: true });
    return;
  }
  const detailButton = event.target.closest("[data-detail-item]");
  if (detailButton) {
    const item = findItem(detailButton.dataset.detailItem);
    const day = state.snapshot?.days.find((entry) => entry.items.some((candidate) => candidate.id === item?.id));
    if (item && day) {
      state.view = "detail";
      state.selectedDayId = day.id;
      scrollToDetailCard(document.querySelector(`[data-detail-card="${CSS.escape(item.id)}"]`), { behavior: "smooth", updateRoute: true });
    }
    return;
  }
  if (event.target.closest("#refreshButton") || event.target.closest('[data-action="refresh"]')) { load(); return; }
  const mapButton = event.target.closest("[data-map-preview]");
  if (mapButton) { loadMapPreview(mapButton.dataset.mapPreview); return; }
  const statusButtonElement = event.target.closest("[data-status][data-item-id]");
  if (statusButtonElement) { saveStatus(statusButtonElement.dataset.itemId, statusButtonElement.dataset.status); return; }
  const editButton = event.target.closest("[data-edit-note]");
  if (editButton) {
    const editor = document.querySelector(`[data-note-editor="${CSS.escape(editButton.dataset.editNote)}"]`);
    if (editor) {
      editor.querySelector("[data-note-view]").hidden = true;
      editor.querySelector("[data-note-edit]").hidden = false;
      editor.querySelector("[data-note-input]").focus();
    }
    return;
  }
  const colorButton = event.target.closest("[data-note-color]");
  if (colorButton) {
    return;
  }
  const cancelButton = event.target.closest("[data-cancel-note]");
  if (cancelButton) { render(); return; }
  const noteButton = event.target.closest("[data-save-note]");
  if (noteButton) saveNote(noteButton.dataset.saveNote);
});

window.addEventListener("popstate", () => { if (state.snapshot) { routeFromLocation(); render(); } });
window.addEventListener("hashchange", () => { if (state.snapshot) { routeFromLocation(); render(); } });
window.addEventListener("beforeunload", () => clearInterval(state.pollTimer));
load();
