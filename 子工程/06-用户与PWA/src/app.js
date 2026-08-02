import { supabaseClient as client } from "./supabase-client.js";

const state = {
  view: location.hash.replace(/^#/, "") || "discover",
  listTab: "trips",
  trips: [],
  countries: [],
  activeTripId: null,
  recommendations: { level: "continents", continent: null, country: null, city: null, items: [], detail: null, detailId: null, detailCache: new Map(), detailValues: new Map(), loading: false },
  recovery: false,
  installPrompt: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const dateLabel = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)) : "未定日期";
const makeId = () => crypto.randomUUID?.() || `trip-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const EXTERNAL_VIEWS = {
  planner: "../04-旅程规划/planner.html",
  guide: "../05-当前行程导览/guide.html"
};

const elements = {
  toast: $("#toast"),
  backdrop: $("#modalBackdrop"),
  authModal: $("#authModal"),
  tripModal: $("#tripModal"),
  installModal: $("#installModal")
};

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function guestSnapshot() {
  return client.guestState();
}

function persistGuest() {
  client.saveGuestState({ guestId: guestSnapshot().guestId, trips: state.trips, countries: state.countries, activeTripId: state.activeTripId });
}

function setView(view) {
  const valid = ["discover", "planner", "guide", "trips", "account"];
  state.view = valid.includes(view) ? view : "discover";
  if (EXTERNAL_VIEWS[state.view]) {
    window.location.assign(EXTERNAL_VIEWS[state.view]);
    return;
  }
  if (location.hash !== `#${state.view}`) history.replaceState(null, "", `#${state.view}`);
  $$(`.view`).forEach((section) => { section.hidden = section.dataset.view !== state.view; });
  $$(`.nav-item`).forEach((item) => item.classList.toggle("is-active", item.dataset.nav === state.view));
  if (state.view === "account") renderAccount();
  if (state.view === "trips") renderLists();
  if (state.view === "guide") renderGuide();
  if (state.view === "discover") renderRecommendations();
}

function openModal(modal, html) {
  [elements.authModal, elements.tripModal, elements.installModal].forEach((item) => { item.hidden = item !== modal; });
  modal.innerHTML = html;
  elements.backdrop.hidden = false;
  document.body.classList.add("modal-open");
  modal.querySelector("input, button")?.focus();
}

function closeModal() {
  elements.backdrop.hidden = true;
  [elements.authModal, elements.tripModal, elements.installModal].forEach((item) => { item.hidden = true; item.innerHTML = ""; });
  document.body.classList.remove("modal-open");
}

function authForm(mode = "login", message = "") {
  state.authMode = mode;
  const recovery = mode === "update";
  const reset = mode === "reset";
  const signup = mode === "signup";
  const title = recovery ? "设置新密码" : reset ? "找回密码" : signup ? "创建账号" : "登录旅程";
  const subtitle = recovery ? "设置一个新的密码，完成账号恢复。" : reset ? "输入注册邮箱，我们会发送恢复链接。" : signup ? "保存行程到云端，在不同设备继续。" : "登录后，你的清单和行程会自动同步。";
  const fields = recovery
    ? `<label class="field-label" for="authPassword">新密码</label><input id="authPassword" name="password" type="password" minlength="6" autocomplete="new-password" required placeholder="至少 6 位">`
    : `<label class="field-label" for="authEmail">邮箱</label><input id="authEmail" name="email" type="email" autocomplete="email" required placeholder="name@example.com">${reset ? "" : `<label class="field-label" for="authPassword">密码</label><input id="authPassword" name="password" type="password" minlength="6" autocomplete="${signup ? "new-password" : "current-password"}" required placeholder="至少 6 位">`}`;
  openModal(elements.authModal, `<button class="modal-close" type="button" data-close aria-label="关闭">×</button><p class="eyebrow">ACCOUNT</p><h2 id="authTitle">${title}</h2><p class="modal-subtitle">${subtitle}</p><form id="authForm" class="auth-form"><div class="form-fields">${fields}</div><button class="primary-button wide" type="submit">${recovery ? "更新密码" : reset ? "发送恢复邮件" : signup ? "注册" : "登录"}</button><p class="form-message" id="authMessage" role="status">${escapeHtml(message)}</p></form><div class="modal-links">${recovery ? "" : reset ? `<button type="button" class="link-button" data-auth-mode="login">返回登录</button>` : `<button type="button" class="link-button" data-auth-mode="${signup ? "login" : "signup"}">${signup ? "已有账号？登录" : "创建新账号"}</button><button type="button" class="link-button" data-auth-mode="reset">忘记密码？</button>`}</div>`);
  $("#authForm").addEventListener("submit", handleAuthSubmit);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#authMessage");
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  message.className = "form-message";
  message.textContent = "处理中…";
  try {
    const data = new FormData(form);
    if (state.authMode === "update") {
      await client.updatePassword(String(data.get("password")));
      history.replaceState(null, "", "#account");
      state.recovery = false;
      closeModal();
      setView("account");
      showToast("密码已更新");
      return;
    }
    if (state.authMode === "reset") {
      await client.sendPasswordReset(String(data.get("email")));
      message.className = "form-message success";
      message.textContent = "恢复邮件已发送，请检查收件箱。";
      submit.disabled = false;
      return;
    }
    if (state.authMode === "signup") {
      const result = await client.signUp(String(data.get("email")), String(data.get("password")));
      message.className = "form-message success";
      message.textContent = result.access_token ? "注册成功，正在进入…" : "注册成功，请先查收确认邮件。";
      if (!result.access_token) { submit.disabled = false; return; }
    } else {
      await client.signIn(String(data.get("email")), String(data.get("password")));
    }
    closeModal();
    await hydrate();
    setView("account");
    showToast("已登录，正在同步数据");
  } catch (error) {
    message.className = "form-message error";
    message.textContent = client.authError(error);
    submit.disabled = false;
  }
}

function renderAccount() {
  const user = client.user;
  const guest = guestSnapshot();
  const migrationCount = (guest.trips?.length || 0) + (guest.countries?.length || 0);
  const accountCard = $("#accountCard");
  if (!user) {
    accountCard.innerHTML = `<div class="account-identity guest-identity"><span class="avatar" aria-hidden="true">○</span><div><strong>游客模式</strong><small>数据保存在此设备</small></div><button class="primary-button small" type="button" data-auth-open="login">登录 / 注册</button></div><div class="guest-note"><span class="note-mark" aria-hidden="true">i</span><span>登录后可以在多台设备查看行程；本机已有 ${migrationCount} 项游客数据可迁移。</span></div>`;
  } else {
    accountCard.innerHTML = `<div class="account-identity"><span class="avatar" aria-hidden="true">${escapeHtml((user.email || "旅").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(user.email || "已登录用户")}</strong><small>云端同步已开启</small></div><button class="secondary-button small" type="button" id="signOutButton">退出</button></div>${migrationCount ? `<div class="migration-box"><div><strong>发现 ${migrationCount} 项游客数据</strong><small>登录前保存在此设备，确认后合并到云端。</small></div><button class="primary-button small" type="button" id="migrateButton">迁移</button></div>` : ""}`;
    $("#signOutButton").addEventListener("click", handleSignOut);
    $("#migrateButton")?.addEventListener("click", handleMigration);
  }
  $("#activeTripSetting").textContent = activeTrip()?.name || "未选择";
  $("#configNote").hidden = client.isConfigured();
  $("#configNote").textContent = "当前未注入 Supabase publishable key。游客模式、App 壳和离线缓存可用，登录与云端同步需完成部署配置。";
}

function selectionMode(attractionId) {
  const row = state.countries.find((item) => item.attractionId === attractionId || item.attraction_id === attractionId);
  if (!row) return "none";
  return row.visitMode || (row.visit_mode === "not_planned" ? "none" : row.visit_mode) || "none";
}

function recommendationStatus(message = "") {
  const target = $("#recommendationStatus");
  if (target) target.textContent = message;
}

function recommendationBreadcrumb() {
  const { level, continent, country, city } = state.recommendations;
  const labels = [continent?.name_zh || "大洲"];
  if (level !== "continents" && country) labels.push(country.name_zh);
  if ((level === "attractions" || level === "detail") && city) labels.push(city.name_zh);
  $("#recommendationBreadcrumb").textContent = labels.join(" / ");
  $("#recommendationBack").hidden = level === "continents";
}

function recommendationCard(item, kind) {
  if (kind === "attraction") {
    const mode = selectionMode(item.id);
    const modeLabel = { inside: "入内参观", outside: "外部参观", none: "未安排" }[mode];
    return `<article class="recommendation-card attraction-recommendation-card"><button class="recommendation-open" type="button" data-rec-open="attraction" data-id="${escapeHtml(item.id)}"><span class="recommendation-card-title">${escapeHtml(item.name_zh)}</span><span class="recommendation-card-en">${escapeHtml(item.name_en)}</span><span class="recommendation-card-meta">${escapeHtml(item.tag || "景点")}${item.duration_label ? ` · ${escapeHtml(item.duration_label)}` : ""}${item.rating ? ` · ${escapeHtml(item.rating)} 分` : ""}</span></button><button class="visit-mode mode-${mode}" type="button" data-rec-visit="${escapeHtml(item.id)}" aria-pressed="${mode !== "none"}">${modeLabel}</button></article>`;
  }
  const title = `${item.name_zh}`;
  const subtitle = item.name_en || item.slug || "";
  const meta = kind === "country" ? "进入城市目录" : kind === "city" ? "进入景点目录" : "查看国家";
  return `<button class="recommendation-card destination-card" type="button" data-rec-open="${kind}" data-id="${escapeHtml(item.id)}"><span class="recommendation-card-title">${escapeHtml(title)}</span><span class="recommendation-card-en">${escapeHtml(subtitle)}</span><span class="recommendation-card-meta">${meta}</span></button>`;
}

function detailNavigation() {
  const rec = state.recommendations;
  const index = rec.items.findIndex((item) => item.id === rec.detailId);
  if (index < 0 || rec.items.length < 2) return "";
  const previous = rec.items[index - 1];
  const next = rec.items[index + 1];
  return `<div class="detail-navigation" aria-label="切换景点"><button class="detail-nav-button" type="button" data-rec-detail-step="-1" aria-label="上一个景点" title="上一个景点" ${previous ? "" : "disabled"}>‹</button><span>${index + 1} / ${rec.items.length}</span><button class="detail-nav-button" type="button" data-rec-detail-step="1" aria-label="下一个景点" title="下一个景点" ${next ? "" : "disabled"}>›</button></div>`;
}

function catalogText(value) {
  if (value == null || value === "") return "暂无";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.filter((item) => item != null && String(item).trim()).map(catalogText).join("；") || "暂无";
  for (const key of ["raw", "label", "text", "value", "description"]) {
    if (value[key] != null && String(value[key]).trim()) return String(value[key]);
  }
  return Object.entries(value)
    .filter(([key, item]) => !/^(raw|duration_raw|hours_raw|price_raw|internal|source_)/i.test(key) && item != null && String(item).trim())
    .map(([, item]) => typeof item === "object" ? catalogText(item) : String(item))
    .filter(Boolean)
    .join("；") || "暂无";
}

function mapUrl(query) {
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : "";
}

function detailGallery(item, detail) {
  if (detail?.media?.length) return `<div class="detail-gallery">${detail.media.map((photo) => `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.alt_text || item.name_zh)}" loading="lazy">`).join("")}</div>`;
  return `<div class="detail-media-placeholder" aria-hidden="true"></div>`;
}

function detailReviews(detail) {
  if (!detail?.reviews?.length) return `<div class="detail-reviews-slot" data-detail-reviews></div>`;
  return `<div class="detail-reviews-slot" data-detail-reviews><div class="detail-reviews"><strong>评价摘要</strong>${detail.reviews.map((review) => `<p>${escapeHtml(review.review_text)}</p>`).join("")}</div></div>`;
}

function recommendationDetailCard(item, index) {
  const rec = state.recommendations;
  const detail = rec.detailValues?.get(item.id) || null;
  const mode = selectionMode(item.id);
  const query = item.map_query || `${item.name_zh} ${rec.city?.name_zh || ""}`;
  const facts = `<div class="detail-facts"><span>建议时长<strong>${escapeHtml(item.duration_label || "暂无")}</strong></span><span>评分<strong>${item.rating != null ? `${escapeHtml(item.rating)} / 5` : "暂无"}</strong></span><span>评价<strong>${item.review_count != null ? escapeHtml(item.review_count) : "暂无"}</strong></span></div><div class="detail-facts detail-copy"><span>开放时间<strong>${escapeHtml(catalogText(item.opening_hours))}</strong></span><span>票价<strong>${escapeHtml(catalogText(item.ticket_info))}</strong></span></div>`;
  const map = mapUrl(query);
  return `<article class="attraction-detail-card ${item.id === rec.detailId ? "is-selected" : ""}" data-rec-detail-card="${escapeHtml(item.id)}"><header class="detail-heading"><div><span class="eyebrow">${escapeHtml(item.tag || "景点详情")}</span><h2>${escapeHtml(item.name_zh)}</h2><p>${escapeHtml(item.name_en || "")}</p></div><button class="visit-mode mode-${mode}" type="button" data-rec-visit="${escapeHtml(item.id)}" aria-pressed="${mode !== "none"}">${{ inside: "入内参观", outside: "外部参观", none: "不参观" }[mode]}</button></header><div class="enhanced-detail-layout"><div class="enhanced-detail-main"><p class="detail-intro">${escapeHtml(item.description_zh || item.summary_zh || "暂无介绍")}</p><div data-detail-gallery>${detailGallery(item, detail)}</div>${facts}<p class="detail-note">${escapeHtml(item.visit_notes || "")}</p></div><aside class="enhanced-detail-aside">${map ? `<div class="detail-map-card"><iframe title="${escapeHtml(item.name_zh)} 地图" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed"></iframe><a href="${map}" target="_blank" rel="noreferrer">在地图中查看 ↗</a></div>` : ""}${detailReviews(detail)}</aside></div></article>`;
}

function renderRecommendationDetailDeck() {
  const rec = state.recommendations;
  const city = rec.city;
  const chips = rec.items.map((item) => `<button class="detail-chip ${item.id === rec.detailId ? "is-active" : ""}" type="button" data-rec-detail-chip="${escapeHtml(item.id)}">${escapeHtml(item.name_zh)}</button>`).join("");
  return `<article class="city-attraction-view"><button class="text-button small" type="button" data-rec-back>← 返回 ${escapeHtml(city?.name_zh || "景点目录")}</button><header class="city-attraction-heading"><div><p class="eyebrow">ATTRACTION GUIDE</p><h2>${escapeHtml(city?.name_zh || "城市")}</h2><p>${escapeHtml(city?.name_en || "")}</p></div><span class="recommendation-city-count">${rec.items.length} 个景点</span></header><nav class="detail-chip-bar" aria-label="选择景点">${chips}</nav><div class="recommendation-detail-deck" data-rec-detail-deck>${rec.items.map(recommendationDetailCard).join("")}</div></article>`;
}

function scrollRecommendationDetail(id) {
  const card = document.querySelector(`[data-rec-detail-card="${CSS.escape(id)}"]`);
  if (!card) return;
  const deck = card.closest("[data-rec-detail-deck]");
  // CSS scroll-margin-top keeps the card below the sticky app bar on both
  // desktop and mobile while scrollIntoView also handles the horizontal deck.
  card.scrollIntoView({ behavior: "smooth", block: "start", inline: "start" });
  if (deck && window.matchMedia("(max-width: 620px)").matches) deck.scrollTo({ left: card.offsetLeft, behavior: "smooth" });
}

function renderRecommendations() {
  const content = $("#recommendationContent");
  if (!content) return;
  recommendationBreadcrumb();
  if (state.recommendations.loading) {
    content.innerHTML = `<div class="recommendation-empty"><strong>正在加载目录</strong><span>请稍候。</span></div>`;
    return;
  }
  const { level, items, detail } = state.recommendations;
  if (level === "detail" && detail) {
    content.innerHTML = renderRecommendationDetailDeck();
    requestAnimationFrame(() => {
      const card = content.querySelector(`[data-rec-detail-card="${CSS.escape(state.recommendations.detailId)}"]`);
      scrollRecommendationDetail(state.recommendations.detailId);
      loadRecommendationDetailExtras();
    });
    return;
  }
  if (!items.length) {
    content.innerHTML = `<div class="recommendation-empty"><strong>暂无可显示内容</strong><span>${client.isConfigured() ? "目录中还没有启用记录。" : "注入 publishable key 后即可读取线上目录。"}</span></div>`;
    return;
  }
  const kind = level === "continents" ? "continent" : level === "countries" ? "country" : level === "cities" ? "city" : "attraction";
  content.innerHTML = `<div class="recommendation-grid">${items.map((item) => recommendationCard(item, kind)).join("")}</div>`;
}

function loadRecommendationDetailExtras() {
  const rec = state.recommendations;
  rec.items.forEach((item) => {
    recommendationDetailExtras(item.id).then(({ media, reviews }) => {
      if (rec.level !== "detail") return;
      rec.detailValues.set(item.id, { media, reviews });
      const card = document.querySelector(`[data-rec-detail-card="${CSS.escape(item.id)}"]`);
      const gallery = card?.querySelector("[data-detail-gallery]");
      const review = card?.querySelector("[data-detail-reviews]");
      if (gallery) gallery.innerHTML = detailGallery(item, { media, reviews });
      if (review) review.outerHTML = detailReviews({ media, reviews });
    }).catch(() => {});
  });
}

async function hydrateRecommendations() {
  if (!client.isConfigured()) {
    recommendationStatus("游客模式：目录需要部署配置后读取。");
    return;
  }
  state.recommendations.loading = true;
  renderRecommendations();
  try {
    state.recommendations.level = "continents";
    state.recommendations.continent = null;
    state.recommendations.country = null;
    state.recommendations.city = null;
    state.recommendations.detailCache = new Map();
    state.recommendations.detailValues = new Map();
    state.recommendations.detailId = null;
    state.recommendations.items = await client.listContinents();
    recommendationStatus("公开目录");
  } catch (error) {
    state.recommendations.items = [];
    recommendationStatus(`目录暂不可用：${client.authError(error)}`);
  } finally {
    state.recommendations.loading = false;
    renderRecommendations();
  }
}

async function openRecommendation(kind, id) {
  const rec = state.recommendations;
  if (kind === "attraction") {
    openRecommendationDetail(id);
    return;
  }
  rec.loading = true;
  renderRecommendations();
  try {
    if (kind === "continent") {
      rec.continent = rec.items.find((item) => item.id === id) || null;
      rec.level = "countries";
      rec.items = await client.listCountries(id);
    } else if (kind === "country") {
      rec.country = rec.items.find((item) => item.id === id) || null;
      rec.level = "cities";
      rec.items = await client.listCities(id);
    } else if (kind === "city") {
      rec.city = rec.items.find((item) => item.id === id) || null;
      rec.level = "attractions";
      rec.items = await client.listAttractions(id);
    }
    recommendationStatus("公开目录");
  } catch (error) {
    recommendationStatus(`目录暂不可用：${client.authError(error)}`);
  } finally {
    rec.loading = false;
    renderRecommendations();
  }
}

function recommendationDetailExtras(id) {
  let cached = state.recommendations.detailCache.get(id);
  if (!cached) {
    cached = Promise.all([client.listAttractionMedia(id), client.listAttractionReviews(id)])
      .then(([media, reviews]) => ({ media, reviews }))
      .catch((error) => {
        state.recommendations.detailCache.delete(id);
        throw error;
      });
    state.recommendations.detailCache.set(id, cached);
  }
  return cached;
}

function openRecommendationDetail(id) {
  const rec = state.recommendations;
  const attraction = rec.items.find((item) => item.id === id) || rec.detail;
  if (!attraction) return;
  rec.detail = attraction;
  rec.detailId = id;
  rec.level = "detail";
  rec.loading = false;
  renderRecommendations();
}

async function backRecommendation() {
  const rec = state.recommendations;
  rec.loading = true;
  renderRecommendations();
  try {
    if (rec.level === "detail") { rec.level = "attractions"; rec.detail = null; rec.detailId = null; }
    else if (rec.level === "attractions") { rec.level = "cities"; rec.items = await client.listCities(rec.country.id); }
    else if (rec.level === "cities") { rec.level = "countries"; rec.items = await client.listCountries(rec.continent.id); }
    else if (rec.level === "countries") { rec.level = "continents"; rec.items = await client.listContinents(); }
  } catch (error) {
    recommendationStatus(`目录暂不可用：${client.authError(error)}`);
  } finally {
    rec.loading = false;
    renderRecommendations();
  }
}

async function toggleRecommendationVisit(attractionId) {
  const current = selectionMode(attractionId);
  const next = { none: "inside", inside: "outside", outside: "none" }[current];
  const attraction = [...state.recommendations.items, state.recommendations.detail].find((item) => item?.id === attractionId);
  if (!attraction || !state.recommendations.country) return;
  const row = { attractionId, countryId: state.recommendations.country.id, cityId: state.recommendations.city?.id || "", name_zh: attraction.name_zh, visitMode: next, updatedAt: new Date().toISOString(), source: client.user ? "cloud" : "guest-local" };
  state.countries = [...state.countries.filter((item) => (item.attractionId || item.attraction_id) !== attractionId), row];
  persistGuest();
  renderRecommendations();
  if (state.recommendations.level === "detail") requestAnimationFrame(() => scrollRecommendationDetail(attractionId));
  if (client.user && client.isConfigured()) await client.saveSelection(row).catch(() => showToast("已保存在本机，云端稍后重试"));
}

function activeTrip() {
  return state.trips.find((trip) => trip.id === state.activeTripId) || state.trips[0] || null;
}

function tripCard(trip, compact = false) {
  const active = trip.id === state.activeTripId;
  return `<article class="trip-card ${active ? "is-active" : ""}"><div class="trip-card-top"><span class="trip-status">${active ? "当前行程" : "已保存"}</span><button class="more-button" type="button" data-delete-trip="${escapeHtml(trip.id)}" aria-label="删除 ${escapeHtml(trip.name)}" title="删除行程">×</button></div><h3>${escapeHtml(trip.name)}</h3><p>${dateLabel(trip.startDate)} <span aria-hidden="true">→</span> ${dateLabel(trip.endDate)}</p><div class="trip-card-actions"><button class="secondary-button small" type="button" data-select-trip="${escapeHtml(trip.id)}">${active ? "正在使用" : "设为当前"}</button>${compact ? "" : `<button class="text-button small" type="button" data-go="planner">编辑 <span aria-hidden="true">→</span></button>`}</div></article>`;
}

function renderTripList(target) {
  if (!state.trips.length) {
    target.innerHTML = `<div class="empty-panel list-empty"><span class="panel-icon" aria-hidden="true">▤</span><div><h2>还没有保存的行程</h2><p>先建立一个轻量的行程框架，景点目录接入后可以继续细化。</p></div><button class="primary-button" type="button" id="emptyNewTrip">新建行程</button></div>`;
    $("#emptyNewTrip")?.addEventListener("click", openNewTrip);
    return;
  }
  target.innerHTML = `<div class="trip-list">${state.trips.map((trip) => tripCard(trip)).join("")}</div>`;
}

function renderLists() {
  $("#tabTripCount").textContent = state.trips.length;
  $("#tabCountryCount").textContent = state.countries.length;
  $$(".list-tab").forEach((tab) => {
    const selected = tab.dataset.listTab === state.listTab;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  const panel = $("#listPanel");
  if (state.listTab === "trips") renderTripList(panel);
  else if (!state.countries.length) panel.innerHTML = `<div class="empty-panel list-empty"><span class="panel-icon" aria-hidden="true">☆</span><div><h2>还没有景点清单</h2><p>在景点推荐中选择入内或外部参观，清单会按国家保存。</p></div><button class="secondary-button" type="button" data-go="discover">去发现</button></div>`;
  else panel.innerHTML = `<div class="selection-list">${state.countries.map((item) => `<article><strong>${escapeHtml(item.name_zh || item.attractionId || item.attraction_id)}</strong><span>${item.visitMode === "outside" ? "外部参观" : item.visitMode === "inside" ? "入内参观" : "未安排"}</span></article>`).join("")}</div>`;
}

function renderPlanner() {
  $("#tripCountLabel").textContent = `${state.trips.length} 个`;
  const target = $("#plannerTripList");
  if (!state.trips.length) {
    target.innerHTML = `<div class="planner-empty"><span>还没有行程</span><button class="primary-button small" type="button" id="plannerEmptyNew">新建行程</button></div>`;
    $("#plannerEmptyNew")?.addEventListener("click", openNewTrip);
  } else target.innerHTML = state.trips.slice(0, 3).map((trip) => tripCard(trip, true)).join("");
}

function renderGuide() {
  // The live guide owns its data and status UI. This view remains only as a fallback
  // for a stale hash while the browser navigates to the formal guide entry point.
  const trip = activeTrip();
  $("#guideEmpty").hidden = Boolean(trip);
  $("#guideHero").innerHTML = trip ? `<div class="guide-card"><div><span class="eyebrow">CURRENT TRIP</span><h2>${escapeHtml(trip.name)}</h2><p>${dateLabel(trip.startDate)} → ${dateLabel(trip.endDate)}</p></div><span class="guide-day">打开导览 ↗</span></div>` : "";
}

function renderHeader() {
  const loggedIn = Boolean(client.user);
  $("#syncText").textContent = loggedIn ? "已同步" : "游客模式";
  $("#syncState").dataset.state = loggedIn ? "online" : "offline";
  $("#recentTripLabel").textContent = activeTrip()?.name || "还没有行程";
  $("#activeTripSetting").textContent = activeTrip()?.name || "未选择";
}

function renderAll() {
  renderHeader();
  renderPlanner();
  if (state.view === "account") renderAccount();
  if (state.view === "trips") renderLists();
  if (state.view === "guide") renderGuide();
  setView(state.view);
}

async function hydrate() {
  const guest = guestSnapshot();
  state.countries = guest.countries || [];
  state.activeTripId = guest.activeTripId || null;
  if (client.user && client.isConfigured()) {
    try { state.trips = await client.listTrips(); }
    catch (error) { state.trips = guest.trips || []; showToast(`云端暂不可用：${client.authError(error)}`); }
    try { state.activeTripId = await client.getActiveTripId(); }
    catch (error) { state.activeTripId = null; showToast(`当前行程暂不可用：${client.authError(error)}`); }
  } else state.trips = guest.trips || [];
  if (client.user && client.isConfigured()) {
    try { state.countries = (await client.listSelections()).map((row) => ({ ...row, attractionId: row.attraction_id, countryId: row.country_id, visitMode: row.visit_mode === "not_planned" ? "none" : row.visit_mode, updatedAt: row.updated_at, source: "cloud" })); }
    catch (error) { showToast(`清单暂不可用：${client.authError(error)}`); }
  }
  await hydrateRecommendations();
  if (!client.user || !client.isConfigured()) {
    if (state.activeTripId && !state.trips.some((trip) => trip.id === state.activeTripId)) state.activeTripId = state.trips[0]?.id || null;
  } else if (state.activeTripId && !state.trips.some((trip) => trip.id === state.activeTripId)) {
    state.activeTripId = null;
  }
  renderAll();
}

function openNewTrip() {
  openModal(elements.tripModal, `<button class="modal-close" type="button" data-close aria-label="关闭">×</button><p class="eyebrow">NEW TRIP</p><h2 id="tripTitle">新建行程</h2><p class="modal-subtitle">先保存一个框架，之后可以继续补充城市和景点。</p><form id="tripForm" class="auth-form"><div class="form-fields"><label class="field-label" for="tripName">行程名称</label><input id="tripName" name="name" required maxlength="60" placeholder="如：德国秋日路线"><div class="date-fields"><div><label class="field-label" for="tripStart">出发日期</label><input id="tripStart" name="startDate" type="date" required></div><div><label class="field-label" for="tripEnd">返程日期</label><input id="tripEnd" name="endDate" type="date" required></div></div><label class="field-label" for="tripNote">一句备注 <span class="label-optional">可选</span></label><textarea id="tripNote" name="note" rows="3" maxlength="160" placeholder="想在这趟旅程里完成什么？"></textarea></div><button class="primary-button wide" type="submit">保存行程</button></form>`);
  $("#tripForm").addEventListener("submit", handleNewTrip);
}

async function handleNewTrip(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const trip = { id: makeId(), name: String(data.get("name")).trim(), startDate: String(data.get("startDate") || ""), endDate: String(data.get("endDate") || ""), payload: { note: String(data.get("note") || "").trim() } };
  state.trips = [trip, ...state.trips];
  state.activeTripId = trip.id;
  persistGuest();
  if (client.user && client.isConfigured()) {
    try { await client.saveTrip(trip); } catch { showToast("已保存在本机，云端稍后重试"); }
  }
  closeModal();
  renderAll();
  setView("trips");
  showToast("行程已保存");
}

async function handleSelectTrip(id) {
  const previousId = state.activeTripId;
  state.activeTripId = id;
  persistGuest();
  renderAll();
  if (client.user && client.isConfigured()) {
    try {
      await client.setActiveTrip(id);
      showToast("已切换当前行程");
    } catch (error) {
      state.activeTripId = previousId;
      persistGuest();
      renderAll();
      showToast(`切换失败：${client.authError(error)}`);
    }
  } else showToast("已切换当前行程（游客本机）");
}

async function handleDeleteTrip(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip || !confirm(`删除“${trip.name}”？此操作不可撤销。`)) return;
  const deletingActiveTrip = state.activeTripId === id;
  state.trips = state.trips.filter((item) => item.id !== id);
  if (deletingActiveTrip) state.activeTripId = client.user && client.isConfigured() ? null : state.trips[0]?.id || null;
  persistGuest();
  if (client.user && client.isConfigured()) await client.deleteTrip(id).catch(() => showToast("本机已删除，云端删除稍后重试"));
  renderAll();
  showToast("行程已删除");
}

async function handleSignOut() {
  await client.signOut();
  await hydrate();
  setView("account");
  showToast("已退出登录");
}

async function handleMigration() {
  const button = $("#migrateButton");
  button.disabled = true;
  button.textContent = "迁移中…";
  try {
    const result = await client.migrateGuestData();
    showToast(`已迁移 ${result.trips + result.countries} 项数据`);
    renderAccount();
  } catch (error) {
    showToast(`迁移失败：${client.authError(error)}`);
    button.disabled = false;
    button.textContent = "重试迁移";
  }
}

function openInstallHelp() {
  const canPrompt = Boolean(state.installPrompt);
  openModal(elements.installModal, `<button class="modal-close" type="button" data-close aria-label="关闭">×</button><p class="eyebrow">INSTALL</p><h2 id="installTitle">把旅程放到主屏幕</h2><p class="modal-subtitle">${canPrompt ? "安装后可以像 App 一样从桌面打开。" : "Safari iPhone：点击底部分享按钮，再选择“添加到主屏幕”。"}</p><div class="install-steps">${canPrompt ? `<div><span>01</span><strong>点击下方安装</strong><small>浏览器会打开系统安装确认。</small></div><button class="primary-button wide" type="button" id="confirmInstall">安装到主屏幕</button>` : `<div><span>01</span><strong>点击 Safari 分享</strong><small>在浏览器底部工具栏找到分享按钮。</small></div><div><span>02</span><strong>选择“添加到主屏幕”</strong><small>确认名称后点击添加。</small></div>`}</div>`);
  $("#confirmInstall")?.addEventListener("click", async () => {
    const prompt = state.installPrompt;
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    state.installPrompt = null;
    closeModal();
  });
}

function exportData() {
  const payload = { exportedAt: new Date().toISOString(), trips: state.trips, countries: state.countries, activeTripId: state.activeTripId };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `travel-app-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("数据备份已下载");
}

function clearGuestData() {
  if (!confirm("清理此设备上的游客数据？已登录的云端数据不会受影响。")) return;
  localStorage.removeItem(client.constants.GUEST_STORAGE_KEY);
  state.trips = client.user ? state.trips : [];
  state.countries = [];
  if (!client.user) state.activeTripId = null;
  renderAll();
  showToast("本地游客数据已清理");
}

function updateOfflineBanner() { $("#offlineBanner").hidden = navigator.onLine; }

async function syncSelectionState() {
  if (client.user && client.isConfigured()) {
    try {
      state.countries = (await client.listSelections()).map((row) => ({ ...row, attractionId: row.attraction_id, countryId: row.country_id, visitMode: row.visit_mode === "not_planned" ? "none" : row.visit_mode, updatedAt: row.updated_at, source: "cloud" }));
    } catch { return; }
  } else state.countries = guestSnapshot().countries || [];
  renderHeader();
  if (state.view === "trips") renderLists();
  if (state.view === "planner") renderPlanner();
}

function bindEvents() {
  window.addEventListener("hashchange", () => setView(location.hash.replace(/^#/, "")));
  document.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close]");
    if (close) closeModal();
    const go = event.target.closest("[data-go]");
    if (go) setView(go.dataset.go);
    const authOpen = event.target.closest("[data-auth-open]");
    if (authOpen) authForm(authOpen.dataset.authOpen);
    const authMode = event.target.closest("[data-auth-mode]");
    if (authMode) authForm(authMode.dataset.authMode);
    const select = event.target.closest("[data-select-trip]");
    if (select) handleSelectTrip(select.dataset.selectTrip);
    const remove = event.target.closest("[data-delete-trip]");
    if (remove) handleDeleteTrip(remove.dataset.deleteTrip);
    const recOpen = event.target.closest("[data-rec-open]");
    if (recOpen) openRecommendation(recOpen.dataset.recOpen, recOpen.dataset.id);
    const detailStep = event.target.closest("[data-rec-detail-step]");
    if (detailStep && !detailStep.disabled) {
      const rec = state.recommendations;
      const index = rec.items.findIndex((item) => item.id === rec.detail?.id);
      const target = rec.items[index + Number(detailStep.dataset.recDetailStep)];
      if (target) scrollRecommendationDetail(target.id);
    }
    const detailChip = event.target.closest("[data-rec-detail-chip]");
    if (detailChip) scrollRecommendationDetail(detailChip.dataset.recDetailChip);
    const recVisit = event.target.closest("[data-rec-visit]");
    if (recVisit) toggleRecommendationVisit(recVisit.dataset.recVisit);
    if (event.target.closest("[data-rec-back]")) backRecommendation();
  });
  elements.backdrop.addEventListener("click", (event) => { if (event.target === elements.backdrop) closeModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !elements.backdrop.hidden) closeModal(); });
  $("#newTripButton").addEventListener("click", openNewTrip);
  $("#exportButton").addEventListener("click", exportData);
  $("#clearGuestButton").addEventListener("click", clearGuestData);
  $("#installHelpButton").addEventListener("click", openInstallHelp);
  $("#installButton").addEventListener("click", openInstallHelp);
  $("#recommendationBack").addEventListener("click", backRecommendation);
  $("#recommendationRefresh").addEventListener("click", hydrateRecommendations);
  $$(".list-tab").forEach((tab) => tab.addEventListener("click", () => { state.listTab = tab.dataset.listTab; renderLists(); }));
  window.addEventListener("online", updateOfflineBanner);
  window.addEventListener("offline", updateOfflineBanner);
  window.addEventListener("travel-selection-updated", () => syncSelectionState().catch(() => showToast("清单同步失败，请稍后刷新")));
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.installPrompt = event; $("#installButton").hidden = false; });
  window.addEventListener("appinstalled", () => { state.installPrompt = null; $("#installButton").hidden = true; showToast("已添加到主屏幕"); });
}

async function boot() {
  bindEvents();
  updateOfflineBanner();
  client.onAuthStateChange(() => hydrate());
  state.recovery = await client.recoverSessionFromHash();
  await client.initialize();
  await hydrate();
  if (state.recovery) authForm("update");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../" }).catch(() => {});
}

boot();
