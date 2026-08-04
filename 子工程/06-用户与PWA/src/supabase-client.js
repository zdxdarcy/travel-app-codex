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
  const query = `countries?select=id,region_id,name_zh,name_en,slug,iso_code&region_id=eq.${encodeURIComponent(continentId)}&is_active=eq.true&order=name_zh`;
  return publicTable(query);
}

async function listRegions(countryId) {
  const cityRows = await publicTable(`cities?select=region_id&country_id=eq.${encodeURIComponent(countryId)}&region_id=not.is.null&is_active=eq.true`);
  const ids = [...new Set((cityRows || []).map((row) => row.region_id).filter(Boolean))];
  if (!ids.length) return [];
  return publicTable(`regions?select=id,parent_region_id,name_zh,name_en,slug,code&is_active=eq.true&id=in.(${ids.join(",")})&order=name_zh`);
}

async function listCities(countryId, regionId = null) {
  let query = `cities?select=id,country_id,region_id,name_zh,name_en,slug,latitude,longitude&country_id=eq.${encodeURIComponent(countryId)}&is_active=eq.true&order=name_zh`;
  if (regionId) query += `&region_id=eq.${encodeURIComponent(regionId)}`;
  return publicTable(query);
}

async function listAttractions(cityId) {
  return publicTable(`attractions?select=id,city_id,slug,name_zh,name_en,tag,summary_zh,description_zh,duration_label,latitude,longitude,map_query,opening_hours,ticket_info,visit_notes,rating,review_count,rating_source&city_id=eq.${encodeURIComponent(cityId)}&is_active=eq.true&order=name_zh`);
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
  deleteTrip,
  listContinents,
  listCountries,
  listRegions,
  listCities,
  listAttractions,
  listLatestPublishedAttractions,
  listLatestPublishedCities,
  listAttractionMedia,
  listAttractionReviews,
  listSelections,
  saveSelection,
  migrateGuestData,
  guestState,
  saveGuestState,
  authError
};
