// Shared USGS / NWS helpers used by both the map and the station popup.

// A reading older than this is not "current conditions" and is shown greyed out.
export const STALE_AFTER_DAYS = 7;

// USGS qualifier codes that mean the value is not a trustworthy measurement.
// 'P' (provisional) and 'A' (approved) are normal and must not be treated as bad.
export const BAD_QUALIFIERS = ['Eqp', 'Mnt', 'Dis', 'Ice', '***'];

export const QUALIFIER_LABELS = {
  Eqp: 'Equipment malfunction',
  Mnt: 'Station maintenance',
  Dis: 'Record discontinued',
  Ice: 'Ice affected',
  Ssn: 'Outside seasonal range',
  Bkw: 'Backwater affected',
  Fld: 'Flood affected',
  e: 'Estimated',
  '***': 'Temporarily unavailable'
};

// Formats an elapsed duration as a bare quantity ("22 min", "3 days", "12.2 yr").
// Callers supply the label that says what the duration measures.
export const formatSampleAge = (ageMs) => {
  const hours = ageMs / (60 * 60 * 1000);
  if (hours < 1) return `${Math.max(1, Math.round(ageMs / 60000))} min`;
  if (hours < 48) return `${Math.round(hours)} hr`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days} days`;
  const years = (days / 365).toFixed(1);
  return `${years} yr`;
};

// Parameters fetched for the popup, keyed by USGS parameter code.
const DETAIL_PARAMS = {
  '00065': 'gageHeight',
  '00060': 'discharge',
  '00010': 'waterTemp',
  '00300': 'dissolvedOxygen'
};

// NWS flood categories, lowest first.
export const FLOOD_LEVELS = ['action', 'minor', 'moderate', 'major'];

const NWPS_BASE = 'https://api.water.noaa.gov/nwps/v1';

// Popup detail is fetched lazily per station and reused for the same interval
// the map polls at, so reopening a popup doesn't re-download a week of data.
const DETAIL_TTL_MS = 15 * 60 * 1000;
const detailCache = new Map();

// Drops the -999999 sentinel, NaN and qualifier-flagged values from one block.
const validPoints = (block) =>
  (block.value || [])
    .map((p) => ({
      t: new Date(p.dateTime).getTime(),
      v: parseFloat(p.value),
      qualifiers: p.qualifiers || []
    }))
    .filter(
      (p) =>
        Number.isFinite(p.t) &&
        Number.isFinite(p.v) &&
        p.v > -999999 &&
        !p.qualifiers.some((q) => BAD_QUALIFIERS.includes(q))
    );

// Same multi-block problem as the pH feed: a discontinued sensor can sit in
// block 0 with no data, so keep whichever block has the most recent valid point.
const pickBestBlock = (series) => {
  let best = null;
  (series.values || []).forEach((block) => {
    const points = validPoints(block);
    if (points.length === 0) return;
    if (!best || points[points.length - 1].t > best[best.length - 1].t) {
      best = points;
    }
  });
  return best;
};

const fetchUsgsHistory = async (siteId) => {
  const response = await fetch(
    `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteId}` +
      `&parameterCd=${Object.keys(DETAIL_PARAMS).join(',')}&period=P7D`
  );
  if (!response.ok) throw new Error(`USGS returned ${response.status}`);
  const data = await response.json();

  const readings = {};
  (data.value?.timeSeries || []).forEach((series) => {
    const key = DETAIL_PARAMS[series.variable.variableCode[0].value];
    const points = key && pickBestBlock(series);
    if (points) readings[key] = points;
  });
  return readings;
};

// Returns null when the site is not an NWS forecast point (a 404, which is
// common for water-quality-only sites) and { error } when NWS is unreachable,
// so the popup can tell "no flood stages exist" from "couldn't load them".
const fetchFloodInfo = async (siteId) => {
  try {
    const response = await fetch(`${NWPS_BASE}/gauges/${siteId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`NWS returned ${response.status}`);
    const gauge = await response.json();

    // NWS uses -9999 for a category it hasn't defined at this gauge.
    const stages = FLOOD_LEVELS.map((level) => ({
      level,
      stage: gauge.flood?.categories?.[level]?.stage
    })).filter((s) => Number.isFinite(s.stage) && s.stage > -9000);

    let forecast = [];
    const forecastStatus = gauge.status?.forecast?.floodCategory;
    if (forecastStatus && forecastStatus !== 'fcst_not_current') {
      try {
        const res = await fetch(`${NWPS_BASE}/gauges/${gauge.lid}/stageflow/forecast`);
        const body = res.ok ? await res.json() : null;
        if (body?.primaryUnits === 'ft') {
          forecast = (body.data || [])
            .map((d) => ({ t: new Date(d.validTime).getTime(), v: d.primary }))
            .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > -9000);
        }
      } catch {
        // A missing forecast just means no dashed line; the stages still apply.
      }
    }

    return {
      lid: gauge.lid,
      stages,
      observedCategory: gauge.status?.observed?.floodCategory,
      forecast
    };
  } catch (err) {
    return { error: err.message };
  }
};

export const fetchStationDetail = (siteId) => {
  const cached = detailCache.get(siteId);
  if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.promise;

  const promise = Promise.all([fetchUsgsHistory(siteId), fetchFloodInfo(siteId)]).then(
    ([readings, flood]) => ({ readings, flood })
  );
  // Don't cache failures, so reopening the popup retries.
  promise.catch(() => detailCache.delete(siteId));
  detailCache.set(siteId, { at: Date.now(), promise });
  return promise;
};
