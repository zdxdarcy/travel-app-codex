import { supabaseClient } from "../../../子工程/06-用户与PWA/src/supabase-client.js";

const TRIP_FIELDS = "id,user_id,name,start_date,end_date,start_location,end_location,status,notes,updated_at";
const DAY_FIELDS = "id,trip_id,day_number,day_date,notes,updated_at";
const ITEM_FIELDS = "id,trip_day_id,item_type,attraction_id,title_snapshot,city_name_snapshot,planned_order,visit_mode,visit_status,duration_minutes,notes,metadata,updated_at";
const ATTRACTION_FIELDS = "id,city_id,slug,name_zh,name_en,tag,summary_zh,description_zh,duration_label,map_query,opening_hours,ticket_info,visit_notes,rating,review_count,rating_source,updated_at,is_active";

const VISIT_MODES = new Set(["inside", "outside", "not_planned"]);
const VISIT_STATUSES = new Set(["not_started", "completed", "skipped"]);

export class GuideError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "GuideError";
    this.code = code;
    this.cause = cause;
  }
}

function queryValue(value) {
  return encodeURIComponent(String(value));
}

function isConfigured() {
  return supabaseClient.isConfigured();
}

function mapError(error) {
  const message = error?.message || String(error || "请求失败");
  if (message === "SUPABASE_NOT_CONFIGURED") {
    return new GuideError("NETWORK_OFFLINE", "尚未注入 Supabase publishable key。", error);
  }
  if (/failed to fetch|network|offline/i.test(message)) {
    return new GuideError("NETWORK_OFFLINE", "当前无法连接行程服务。", error);
  }
  return new GuideError("NETWORK_OFFLINE", message, error);
}

async function rest(path, options = {}) {
  if (!isConfigured()) throw new GuideError("NETWORK_OFFLINE", "尚未注入 Supabase publishable key。");
  const session = supabaseClient.session;
  const key = supabaseClient.config.key;
  const accessToken = session?.access_token || key;
  if (!accessToken) throw new GuideError("AUTH_REQUIRED", "请先登录后查看当前行程。");

  try {
    const response = await fetch(`${supabaseClient.config.url}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const message = body?.message || body?.msg || body?.details || body?.error || `请求失败（${response.status}）`;
      throw new GuideError("NETWORK_OFFLINE", message, body);
    }
    return body;
  } catch (error) {
    if (error instanceof GuideError) throw error;
    throw mapError(error);
  }
}

function decodeDayNotes(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { text: raw };
  } catch {
    return { text: raw };
  }
}

function normalizeCities(value) {
  if (!Array.isArray(value)) return [];
  return value.map((city) => {
    if (typeof city === "string") return { id: city, name: city, nameEn: null };
    return { id: city?.id || city?.name || city?.name_zh || "city", name: city?.name || city?.name_zh || city?.nameZh || "未命名城市", nameEn: city?.nameEn || city?.name_en || null };
  }).filter((city) => city.name);
}

function normalizeMode(value) {
  return VISIT_MODES.has(value) ? (value === "not_planned" ? "none" : value) : "none";
}

function normalizeStatus(value) {
  return VISIT_STATUSES.has(value) ? value : "not_started";
}

function parseJsonValue(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function detailsFor(attraction, media, reviews) {
  if (!attraction) return null;
  const hours = parseJsonValue(attraction.opening_hours, {});
  const price = parseJsonValue(attraction.ticket_info, {});
  return {
    id: attraction.id,
    name: attraction.name_zh || attraction.name_en || "未命名景点",
    nameEn: attraction.name_en || null,
    intro: attraction.description_zh || attraction.summary_zh || null,
    tag: attraction.tag || null,
    hours: formatObject(hours),
    price: formatObject(price),
    duration: attraction.duration_label || null,
    tips: attraction.visit_notes || null,
    photos: (media.get(attraction.id) || []).filter((row) => row.media_type === "image").map((row) => ({ url: row.url, alt: row.alt_text || attraction.name_zh })).slice(0, 6),
    reviewSummaries: reviews.get(attraction.id) || [],
    rating: attraction.rating == null ? null : Number(attraction.rating),
    reviewCount: attraction.review_count == null ? null : Number(attraction.review_count),
    ratingSource: attraction.rating_source || null,
    mapQuery: attraction.map_query || attraction.name_zh || null,
    updatedAt: attraction.updated_at || null,
    isActive: attraction.is_active !== false
  };
}

function formatObject(value) {
  if (value == null || typeof value !== "object") return value ? String(value) : null;
  if (Array.isArray(value)) return value.filter((item) => item != null && String(item).trim()).map((item) => formatObject(item) || String(item)).join(" · ") || null;
  // The first import kept raw source text under an internal `raw` key. Prefer
  // that text and never expose storage-only field names in the guide UI.
  for (const key of ["raw", "label", "text", "value", "description"]) {
    if (value[key] != null && String(value[key]).trim()) return String(value[key]);
  }
  const visible = Object.entries(value)
    .filter(([key, item]) => !/^(raw|duration_raw|hours_raw|price_raw|internal|source_)/i.test(key) && item != null && String(item).trim())
    .map(([, item]) => typeof item === "object" ? formatObject(item) : String(item))
    .filter(Boolean);
  return visible.join(" · ") || null;
}

function metadataFor(item) {
  return item.metadata && typeof item.metadata === "object" ? item.metadata : {};
}

function itemKind(item) {
  if (item.item_type === "attraction") return "place";
  if (["lodging", "transport"].includes(item.item_type)) return "logistics";
  if (item.item_type === "meal") return "meal";
  return "custom";
}

function itemLabel(item, details) {
  return details?.name || item.title_snapshot || "未命名安排";
}

function mapLogistics(item) {
  const metadata = metadataFor(item);
  const kind = metadata.kind || item.item_type;
  const labels = { lodging: "住宿", transport: "交通", pickup: "取车", parking: "停车", dropoff: "还车", start: "起点" };
  return {
    label: labels[kind] || (item.item_type === "lodging" ? "住宿" : "行程安排"),
    kind,
    mapQuery: metadata.map_query || item.title_snapshot || null,
    note: item.notes || metadata.note || null
  };
}

function mapMeals(item) {
  const metadata = metadataFor(item);
  return { mealType: metadata.meal_type || metadata.kind || "餐饮", note: item.notes || metadata.note || item.title_snapshot || null };
}

async function loadAttractionBundle(ids) {
  if (!ids.length) return { attractions: new Map(), media: new Map(), reviews: new Map() };
  const idFilter = ids.join(",");
  const [attractions, media, reviews] = await Promise.all([
    rest(`attractions?select=${ATTRACTION_FIELDS}&id=in.(${idFilter})`),
    rest(`attraction_media?select=id,attraction_id,media_type,url,alt_text,sort_order&attraction_id=in.(${idFilter})&is_active=eq.true&order=sort_order`),
    rest(`attraction_review_summaries?select=id,attraction_id,review_type,review_text,sort_order,source_name&attraction_id=in.(${idFilter})&is_active=eq.true&order=sort_order`)
  ]);
  const attractionMap = new Map((attractions || []).map((row) => [row.id, row]));
  const mediaMap = new Map();
  (media || []).forEach((row) => { if (!mediaMap.has(row.attraction_id)) mediaMap.set(row.attraction_id, []); mediaMap.get(row.attraction_id).push(row); });
  const reviewMap = new Map();
  (reviews || []).forEach((row) => { if (!reviewMap.has(row.attraction_id)) reviewMap.set(row.attraction_id, []); reviewMap.get(row.attraction_id).push(row); });
  return { attractions: attractionMap, media: mediaMap, reviews: reviewMap };
}

function buildSnapshot(trip, days, items, bundle) {
  const itemsByDay = new Map();
  (items || []).forEach((item) => { if (!itemsByDay.has(item.trip_day_id)) itemsByDay.set(item.trip_day_id, []); itemsByDay.get(item.trip_day_id).push(item); });
  const normalizedDays = (days || []).slice().sort((a, b) => a.day_number - b.day_number).map((day) => {
    const dayNotes = decodeDayNotes(day.notes);
    const planner = dayNotes.planner || {};
    const rawItems = (itemsByDay.get(day.id) || []).slice().sort((a, b) => a.planned_order - b.planned_order);
    const guideItems = rawItems.map((item) => {
      const attraction = bundle.attractions.get(item.attraction_id);
      const details = detailsFor(attraction, bundle.media, bundle.reviews);
      const kind = itemKind(item);
      return {
        id: item.id,
        plannedOrder: item.planned_order,
        kind,
        placeId: item.attraction_id || null,
        nameSnapshot: itemLabel(item, details),
        cityName: item.city_name_snapshot || null,
        visitMode: normalizeMode(item.visit_mode),
        details,
        logistics: kind === "logistics" ? mapLogistics(item) : null,
        meal: kind === "meal" ? mapMeals(item) : null,
        metadata: metadataFor(item),
        state: {
          status: normalizeStatus(item.visit_status),
          actualNote: item.notes || metadataFor(item).actual_note || metadataFor(item).annotation || metadataFor(item).note || null,
          updatedAt: item.updated_at || null
        }
      };
    });
    const logistics = guideItems.filter((item) => item.kind === "logistics");
    return {
      id: day.id,
      sequence: day.day_number,
      date: day.day_date || null,
      weekday: weekdayLabel(day.day_date),
      cities: normalizeCities(planner.cities || dayNotes.cities),
      start: planner.start || null,
      accommodation: planner.accommodation ? { label: planner.accommodation, kind: "accommodation", mapQuery: planner.accommodation, note: null } : logistics.find((item) => item.logistics?.kind === "lodging")?.logistics || null,
      meals: planner.meals || {},
      notes: dayNotes.text || dayNotes.note || null,
      items: guideItems
    };
  });
  return {
    trip: {
      id: trip.id,
      title: trip.name || "未命名行程",
      departDate: trip.start_date || null,
      returnDate: trip.end_date || null,
      departLocation: trip.start_location || null,
      returnLocation: trip.end_location || null,
      revision: trip.updated_at || "unknown",
      updatedAt: trip.updated_at || new Date().toISOString()
    },
    days: normalizedDays,
    loadedAt: new Date().toISOString()
  };
}

function weekdayLabel(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${value}T00:00:00`));
}

export async function loadActiveGuide() {
  await supabaseClient.initialize();
  const user = supabaseClient.user;
  if (!user?.id) return { kind: "empty", reason: "AUTH_REQUIRED" };
  const profiles = await rest(`profiles?select=id,active_trip_id&id=eq.${queryValue(user.id)}&limit=1`);
  const activeTripId = profiles?.[0]?.active_trip_id || null;
  if (!activeTripId) return { kind: "empty", reason: "NO_ACTIVE_TRIP" };
  const trips = await rest(`trips?select=${TRIP_FIELDS}&id=eq.${queryValue(activeTripId)}&user_id=eq.${queryValue(user.id)}&limit=1`);
  const trip = trips?.[0];
  if (!trip || trip.status === "archived") throw new GuideError("TRIP_NOT_FOUND", "当前行程不存在或已归档。");
  const days = await rest(`trip_days?select=${DAY_FIELDS}&trip_id=eq.${queryValue(trip.id)}&order=day_number`);
  const dayIds = (days || []).map((day) => day.id);
  const items = dayIds.length ? await rest(`trip_items?select=${ITEM_FIELDS}&trip_day_id=in.(${dayIds.join(",")})&order=planned_order`) : [];
  const attractionIds = [...new Set((items || []).map((item) => item.attraction_id).filter(Boolean))];
  const bundle = await loadAttractionBundle(attractionIds);
  return { kind: "ready", snapshot: buildSnapshot(trip, days, items, bundle) };
}

export async function updateItem(itemId, patch, snapshot) {
  const belongsToSnapshot = snapshot?.days.some((day) => day.items.some((item) => item.id === itemId));
  if (!belongsToSnapshot) throw new GuideError("STATE_CONFLICT", "项目已不属于当前行程，请刷新后重试。");
  const safePatch = {};
  if (Object.hasOwn(patch, "status")) {
    if (!VISIT_STATUSES.has(patch.status)) throw new GuideError("STATE_CONFLICT", "无效的执行状态。");
    safePatch.visit_status = patch.status;
  }
  if (Object.hasOwn(patch, "actualNote")) safePatch.notes = String(patch.actualNote || "").trim() || null;
  const rows = await rest(`trip_items?select=${ITEM_FIELDS}&id=eq.${queryValue(itemId)}`, { method: "PATCH", body: JSON.stringify(safePatch) });
  const row = rows?.[0];
  if (!row) throw new GuideError("STATE_CONFLICT", "项目没有返回更新结果，请刷新后重试。");
  return {
    status: normalizeStatus(row.visit_status),
    actualNote: row.notes || null,
    updatedAt: row.updated_at || null
  };
}

export function externalMapUrl(query) {
  if (!query) return null;
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", query);
  return url.toString();
}

export const guideClient = { loadActiveGuide, updateItem, externalMapUrl };
