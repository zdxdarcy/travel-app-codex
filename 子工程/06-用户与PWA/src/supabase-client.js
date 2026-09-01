/*
 * One small client is shared by every App section.
 * Expected tables are the shared core schema. Catalog reads are public; user
 * rows are protected by RLS with user_id = auth.uid().
 * The browser only receives a publishable/anon key. Never add a service role key here.
 */
const DEFAULT_URL = "https://ogqirzemiceoosfebxgh.supabase.co";
const AUTH_STORAGE_KEY = "travel-app-auth-v1";
const GUEST_STORAGE_KEY = "travel-app-guest-v1";

const runtime = globalThis.__TRAVEL_APP_CONFIG__ || {};
const config = {
  url: String(runtime.SUPABASE_URL || DEFAULT_URL).replace(/\/$/, ""),
  key: String(runtime.SUPABASE_PUBLISHABLE_KEY || "")
};

const listeners = new Set();
let session = readJson(AUTH_STORAGE_KEY, null);
let profileTier = null;
let profileTierUserId = null;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function isConfigured() {
  return Boolean(config.url && config.key && !config.key.startsWith("<") && config.key.length > 20);
}

function emit() {
  listeners.forEach((listener) => listener(session));
}

function setSession(next) {
  session = next || null;
  if (session) writeJson(AUTH_STORAGE_KEY, session);
  else localStorage.removeItem(AUTH_STORAGE_KEY);
  emit();
}

function authHeaders(accessToken) {
  return {
    apikey: config.key,
    Authorization: `Bearer ${accessToken || config.key}`,
    "Content-Type": "application/json"
  };
}

async function request(path, options = {}) {
  if (!isConfigured()) throw new Error("SUPABASE_NOT_CONFIGURED");
  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers: { ...authHeaders(session?.access_token), ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return body;
}

async function refreshIfNeeded() {
  if (!session?.refresh_token) return session;
  const expiry = Number(session.expires_at || 0) * 1000;
  if (expiry > Date.now() + 60_000) return session;
  try {
    const response = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!response.ok) throw new Error("SESSION_REFRESH_FAILED");
    const next = await response.json();
    setSession({ ...next, expires_at: Math.floor(Date.now() / 1000) + Number(next.expires_in || 3600) });
  } catch {
    setSession(null);
  }
  return session;
}

function authError(error) {
  const message = error?.message || String(error);
  if (message === "SUPABASE_NOT_CONFIGURED") return "尚未注入 Supabase publishable key，请先完成部署配置。";
  if (message === "Failed to fetch") return "网络不可用，请检查连接后重试。";
  return message;
}

function guestState() {
  return readJson(GUEST_STORAGE_KEY, { guestId: crypto.randomUUID?.() || `guest-${Date.now()}`, trips: [], countries: [], activeTripId: null });
}

function saveGuestState(state) {
  writeJson(GUEST_STORAGE_KEY, state);
}

async function auth(path, payload) {
  if (!isConfigured()) throw new Error("SUPABASE_NOT_CONFIGURED");
  const response = await fetch(`${config.url}/auth/v1/${path}`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.msg || body.error_description || body.message || "认证失败");
  return body;
}

async function signIn(email, password) {
  const next = await auth("token?grant_type=password", { email, password });
  setSession({ ...next, expires_at: Math.floor(Date.now() / 1000) + Number(next.expires_in || 3600) });
  return session;
}

async function signUp(email, password) {
  const next = await auth("signup", { email, password });
  if (next.access_token) setSession({ ...next, expires_at: Math.floor(Date.now() / 1000) + Number(next.expires_in || 3600) });
  return next;
}

async function sendPasswordReset(email) {
  return auth("recover", { email, redirect_to: `${location.origin}${location.pathname}#recovery` });
}

async function updatePassword(password) {
  await refreshIfNeeded();
  if (!session?.access_token) throw new Error("恢复链接已失效，请重新申请密码重置邮件。");
  return request("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password }) });
}

async function signOut() {
  if (session?.access_token && isConfigured()) {
    await fetch(`${config.url}/auth/v1/logout`, { method: "POST", headers: authHeaders(session.access_token) }).catch(() => {});
  }
  setSession(null);
}

async function recoverSessionFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken) return false;
  setSession({ access_token: accessToken, refresh_token: refreshToken, token_type: params.get("token_type") || "bearer", expires_at: Math.floor(Date.now() / 1000) + Number(params.get("expires_in") || 3600), user: null });
  try {
    const user = await request("/auth/v1/user");
    setSession({ ...session, user });
  } catch { /* the recovery form will report an expired token */ }
  return params.get("type") === "recovery";
}

async function table(path, options = {}) {
  await refreshIfNeeded();
  return request(`/rest/v1/${path}`, { ...options, headers: { Prefer: "return=representation", ...(options.headers || {}) } });
}

async function publicTable(path) {
  return request(`/rest/v1/${path}`, { headers: { Prefer: "return=representation" } });
}

async function listContinents() {
  return publicTable("regions?select=id,name_zh,name_en,slug&region_type=eq.continent&is_active=eq.true&order=name_zh");
}

async function listCountries(continentId) {
  const filters = `&region_id=eq.${encodeURIComponent(continentId)}&is_active=eq.true&order=name_zh`;
  try {
    return await publicTable(`countries?select=id,region_id,name_zh,name_en,slug,iso_code,directory_level,is_vip_only${filters}`);
  } catch (error) {
    // Keep older deployments readable until the additive migration is applied.
    if (!/directory_level|column.*does not exist|PGRST204|schema/i.test(String(error?.message || error))) throw error;
    return publicTable(`countries?select=id,region_id,name_zh,name_en,slug,iso_code${filters}`);
  }
}

async function listRegions(countryId) {
  const cityRows = await publicTable(`cities?select=region_id&country_id=eq.${encodeURIComponent(countryId)}&region_id=not.is.null&is_active=eq.true`);
  const ids = [...new Set((cityRows || []).map((row) => row.region_id).filter(Boolean))];
  if (!ids.length) return [];
  return publicTable(`regions?select=id,parent_region_id,name_zh,name_en,slug,code&is_active=eq.true&id=in.(${ids.join(",")})&order=name_zh`);
}

async function listCities(countryId, regionId = null) {
  let query = `cities?select=id,country_id,region_id,name_zh,name_en,slug,latitude,longitude,is_vip_only&country_id=eq.${encodeURIComponent(countryId)}&is_active=eq.true&order=name_zh`;
  if (regionId) query += `&region_id=eq.${encodeURIComponent(regionId)}`;
  return publicTable(query);
}

async function getUserTier() {
  const userId = session?.user?.id || null;
  if (!userId) { profileTier = null; profileTierUserId = null; return "普通用户"; }
  if (profileTierUserId === userId && profileTier) return profileTier;
  try {
    const rows = await table(`profiles?select=user_tier&id=eq.${encodeURIComponent(userId)}&limit=1`);
    profileTier = rows?.[0]?.user_tier || "普通用户";
  } catch { profileTier = "普通用户"; }
  profileTierUserId = userId;
  return profileTier;
}

async function listAttractions(cityId) {
  return publicTable(`attractions?select=id,city_id,slug,name_zh,name_en,tag,summary_zh,description_zh,duration_label,latitude,longitude,map_query,opening_hours,ticket_info,visit_notes,rating,review_count,rating_source&city_id=eq.${encodeURIComponent(cityId)}&is_active=eq.true&order=name_zh`);
}

async function getAttraction(attractionId) {
  const rows = await publicTable(`attractions?select=id,city_id,slug,name_zh,name_en,tag,summary_zh,description_zh,duration_label,latitude,longitude,map_query,opening_hours,ticket_info,visit_notes,rating,review_count,rating_source&is_active=eq.true&id=eq.${encodeURIComponent(attractionId)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function queryLatestPublishedAttractions(limit, sortField) {
  const safeLimit = Math.max(1, Math.min(24, Number(limit) || 12));
  const query = `attractions?select=id,city_id,slug,name_zh,name_en,tag,summary_zh,duration_label,rating,review_count,${sortField},cities!inner(id,country_id,region_id,name_zh,name_en,slug,is_active,countries!inner(id,region_id,name_zh,name_en,slug,iso_code,is_active))&is_active=eq.true&cities.is_active=eq.true&cities.countries.is_active=eq.true&order=${sortField}.desc,id.desc&limit=${safeLimit}`;
  const rows = await publicTable(query);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const city = row.cities && !Array.isArray(row.cities) ? row.cities : row.cities?.[0];
    const country = city?.countries && !Array.isArray(city.countries) ? city.countries : city?.countries?.[0];
    return { ...row, city: city || null, country: country || null };
  }).filter((row) => row.city?.id && row.country?.id && row.city.is_active !== false && row.country.is_active !== false);
}

async function listLatestPublishedAttractions(limit = 12) {
  try {
    return await queryLatestPublishedAttractions(limit, "created_at");
  } catch (error) {
    const message = String(error?.message || error);
    if (!/created_at|column.*does not exist|PGRST204|schema/i.test(message)) throw error;
    return queryLatestPublishedAttractions(limit, "updated_at");
  }
}

async function queryLatestPublishedCities(limit, sortField) {
  const safeLimit = Math.max(1, Math.min(48, Number(limit) || 2));
  const query = `cities?select=id,country_id,region_id,name_zh,name_en,slug,latitude,longitude,${sortField},countries!inner(id,region_id,name_zh,name_en,slug,iso_code,is_active)&is_active=eq.true&countries.is_active=eq.true&order=${sortField}.desc,id.desc&limit=${safeLimit}`;
  const rows = await publicTable(query);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const country = row.countries && !Array.isArray(row.countries) ? row.countries : row.countries?.[0];
    const { countries, ...city } = row;
    return { city, country: country || null };
  }).filter((row) => row.city?.id && row.country?.id && row.city.is_active !== false && row.country.is_active !== false);
}

async function listLatestPublishedCities(limit = 2) {
  try {
    return await queryLatestPublishedCities(limit, "created_at");
  } catch (error) {
    const message = String(error?.message || error);
    if (!/created_at|column.*does not exist|PGRST204|schema/i.test(message)) throw error;
    return queryLatestPublishedCities(limit, "updated_at");
  }
}

async function listAttractionMedia(attractionId) {
  return publicTable(`attraction_media?select=id,attraction_id,media_type,url,alt_text,sort_order,source_name&attraction_id=eq.${encodeURIComponent(attractionId)}&is_active=eq.true&order=sort_order`);
}

async function listAttractionReviews(attractionId) {
  return publicTable(`attraction_review_summaries?select=id,attraction_id,review_type,review_text,sort_order,source_name&attraction_id=eq.${encodeURIComponent(attractionId)}&is_active=eq.true&order=sort_order`);
}

async function listRecommendedRoutes(countryId) {
  return publicTable(`recommended_routes?select=id,country_id,region_id,slug,name_zh,name_en,area_slug,area_name_zh,area_name_en,summary_zh,duration_days,generation_metadata,source_name,source_url,source_updated_at&country_id=eq.${encodeURIComponent(countryId)}&is_active=eq.true&order=duration_days,name_zh`);
}

async function listRecommendedRouteDays(routeId) {
  return publicTable(`recommended_route_days?select=id,route_id,day_number,title_zh,title_en,summary_zh,overnight_city_name_snapshot,notes&route_id=eq.${encodeURIComponent(routeId)}&is_active=eq.true&order=day_number`);
}

async function listRecommendedRouteItems(dayId) {
  return publicTable(`recommended_route_items?select=id,route_day_id,attraction_id,title_snapshot,city_name_snapshot,planned_order,visit_mode,duration_minutes,notes,transit_notes,metadata&route_day_id=eq.${encodeURIComponent(dayId)}&is_active=eq.true&order=planned_order`);
}

async function listSelections() {
  if (!session?.user?.id) return [];
  return table("user_country_list_items?select=id,user_id,country_id,attraction_id,visit_mode,note,updated_at&order=updated_at.desc");
}

async function saveSelection(selection) {
  if (!session?.user?.id) throw new Error("AUTH_REQUIRED");
  const rows = await table("user_country_list_items?on_conflict=user_id,attraction_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: session.user.id,
      country_id: selection.countryId,
      attraction_id: selection.attractionId,
      visit_mode: selection.visitMode === "none" ? "not_planned" : selection.visitMode,
      note: selection.note || null
    })
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function listTrips() {
  const rows = await table("trips?select=*&order=updated_at.desc");
  return Array.isArray(rows) ? rows.map(normalizeTrip) : [];
}

async function getActiveTripId() {
  if (!session?.user?.id) throw new Error("AUTH_REQUIRED");
  const rows = await table(`profiles?select=active_trip_id&id=eq.${encodeURIComponent(session.user.id)}&limit=1`);
  return Array.isArray(rows) ? (rows[0]?.active_trip_id || null) : null;
}

async function setActiveTrip(tripId) {
  if (!session?.user?.id) throw new Error("AUTH_REQUIRED");
  const rows = await table(`profiles?id=eq.${encodeURIComponent(session.user.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ active_trip_id: tripId || null })
  });
  return Array.isArray(rows) ? (rows[0] || null) : rows;
}

async function saveTrip(trip) {
  const rows = await table("trips?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({
    id: trip.id,
    user_id: session.user.id,
    name: trip.name,
    start_date: trip.startDate,
    end_date: trip.endDate,
    notes: trip.payload?.note || null
  }) });
  return normalizeTrip(Array.isArray(rows) ? rows[0] : rows);
}

function dateAfter(base, offset) {
  const [year, month, day] = String(base).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function localDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function saveRecommendedRouteAsTrip(route, routeDays) {
  if (!session?.user?.id) throw new Error("AUTH_REQUIRED");
  const days = Array.isArray(routeDays) ? routeDays : [];
  const startDate = localDateString();
  const endDate = dateAfter(startDate, Math.max(1, days.length || Number(route?.duration_days) || 1) - 1);
  const tripRows = await table("trips", { method: "POST", body: JSON.stringify({ user_id: session.user.id, name: route?.name_zh || "推荐路线", start_date: startDate, end_date: endDate, status: "planned", notes: JSON.stringify({ text: "由推荐路线加入", planner: { source: "recommended-route", route_id: route?.id || null } }) }) });
  const trip = normalizeTrip(Array.isArray(tripRows) ? tripRows[0] : tripRows);
  if (!trip?.id) throw new Error("创建行程失败：未返回行程 ID");
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const dayRows = await table("trip_days", { method: "POST", body: JSON.stringify({ trip_id: trip.id, day_number: index + 1, day_date: dateAfter(startDate, index), notes: JSON.stringify({ text: day.notes || "", planner: { source: "recommended-route", overnightCity: day.overnight_city_name_snapshot || "" } }) }) });
    const dayId = Array.isArray(dayRows) ? dayRows[0]?.id : dayRows?.id;
    if (!dayId) throw new Error(`创建第 ${index + 1} 天失败：未返回日期 ID`);
    const items = (day.items || []).map((item, itemIndex) => ({ trip_day_id: dayId, item_type: "attraction", attraction_id: item.attraction_id || null, title_snapshot: item.title_snapshot || "未命名景点", city_name_snapshot: item.city_name_snapshot || null, planned_order: itemIndex + 1, visit_mode: "inside", duration_minutes: item.duration_minutes || null, notes: item.notes || null, metadata: { source: "recommended-route", route_id: route?.id || null, route_day_id: day.id || null, transit_notes: item.transit_notes || "" } }));
    if (items.length) await table("trip_items", { method: "POST", body: JSON.stringify(items) });
  }
  for (const item of days.flatMap((day) => day.items || [])) {
    if (item.attraction_id && route?.country_id) await saveSelection({ countryId: route.country_id, attractionId: item.attraction_id, visitMode: "inside", note: `来自推荐路线：${route?.name_zh || "推荐路线"}` });
  }
  await setActiveTrip(trip.id);
  return trip;
}

async function deleteTrip(id) {
  return table(`trips?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function migrateGuestData() {
  const guest = guestState();
  if (!session?.user?.id) throw new Error("请先登录再迁移游客数据。");
  const migrated = [];
  for (const trip of guest.trips || []) {
    await saveTrip({ ...trip, clientGuestId: guest.guestId });
    migrated.push(trip.id);
  }
  if (guest.countries?.length) {
    for (const item of guest.countries) {
      await saveSelection(item);
    }
  }
  return { trips: migrated.length, countries: guest.countries?.length || 0 };
}

function normalizeTrip(row = {}) {
  return {
    id: row.id,
    name: row.name || row.payload?.name || "未命名行程",
    startDate: row.start_date || row.startDate || "",
    endDate: row.end_date || row.endDate || "",
    payload: { note: row.notes || "" },
    clientGuestId: null,
    updatedAt: row.updated_at || null
  };
}

export const supabaseClient = {
  config,
  constants: { AUTH_STORAGE_KEY, GUEST_STORAGE_KEY },
  isConfigured,
  get session() { return session; },
  get user() { return session?.user || null; },
  get userTier() { return profileTier || "普通用户"; },
  getUserTier,
  onAuthStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  initialize: async () => { if (isConfigured()) await refreshIfNeeded(); return session; },
  signIn,
  signUp,
  sendPasswordReset,
  updatePassword,
  signOut,
  recoverSessionFromHash,
  listTrips,
  getActiveTripId,
  setActiveTrip,
  saveTrip,
  saveRecommendedRouteAsTrip,
  deleteTrip,
  listContinents,
  listCountries,
  listRegions,
  listCities,
  listAttractions,
  getAttraction,
  listLatestPublishedAttractions,
  listLatestPublishedCities,
  listAttractionMedia,
  listAttractionReviews,
  listRecommendedRoutes,
  listRecommendedRouteDays,
  listRecommendedRouteItems,
  listSelections,
  saveSelection,
  migrateGuestData,
  guestState,
  saveGuestState,
  authError
};
