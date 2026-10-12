import React, { useEffect, useState } from 'react';
import WaterLevelChart, { STAGE_STYLES } from './WaterLevelChart';
import {
  STALE_AFTER_DAYS,
  QUALIFIER_LABELS,
  formatSampleAge,
  fetchStationDetail
} from './usgs';

// USGS station names are terse all-caps ("L ARKANSAS R NR SEDGWICK, KS").
// Expand the standard abbreviations so the popup title reads as a place name.
const NAME_WORDS = {
  R: 'River',
  C: 'Creek',
  RE: 'Reservoir',
  NR: 'near',
  AT: 'at',
  AB: 'above',
  BL: 'below',
  OF: 'of',
  NF: 'North Fork',
  FAC: 'Facility',
  ASR: 'ASR',
  KS: 'KS'
};

const prettifySiteName = (name) =>
  name
    .split(/\s+/)
    .map((word, i) => {
      const bare = word.replace(/,$/, '');
      const comma = word.endsWith(',') ? ',' : '';
      // Survey-grid style IDs ("25S", "SMW-S11") are codes, not words.
      if (/\d/.test(bare)) return word;
      if (i === 0 && bare === 'L') return 'Little';
      const mapped = NAME_WORDS[bare];
      if (mapped) return mapped + comma;
      return bare.charAt(0) + bare.slice(1).toLowerCase() + comma;
    })
    .join(' ');

const phCategory = (ph) => {
  if (ph < 7) return 'Acidic';
  if (ph < 7.5) return 'Neutral';
  return 'Alkaline';
};

// Value nearest to 24h before the latest point, for trend arrows. Returns null
// when the record doesn't reach back far enough to compare honestly.
const valueDayAgo = (points) => {
  const latest = points[points.length - 1];
  const target = latest.t - 24 * 60 * 60 * 1000;
  let nearest = null;
  points.forEach((p) => {
    if (!nearest || Math.abs(p.t - target) < Math.abs(nearest.t - target)) nearest = p;
  });
  return nearest && Math.abs(nearest.t - target) < 2 * 60 * 60 * 1000 ? nearest.v : null;
};

const Trend = ({ delta, format }) => {
  if (delta === null || !Number.isFinite(delta)) return null;
  const flat = Math.abs(delta) < 1e-9;
  return (
    <span className="text-[11px] text-gray-500">
      {flat ? '→' : delta > 0 ? '↑' : '↓'} {format(Math.abs(delta))} 24h
    </span>
  );
};

const Tile = ({ label, value, unit, children }) => (
  <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
    <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    <div className="mt-0.5 flex items-baseline gap-1">
      <span className="text-base font-semibold text-gray-900 tabular-nums">{value}</span>
      <span className="text-[11px] text-gray-500">{unit}</span>
    </div>
    {children}
  </div>
);

const StatusIcon = ({ ok, color }) =>
  ok ? (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill={color} />
      <path d="M4.5 8.2l2.3 2.3 4.7-4.9" stroke="#ffffff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <path d="M8 1.5L15 14H1z" fill={color} />
      <path d="M8 6v3.6M8 11.6v.1" stroke="#111827" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );

const FLOOD_LABELS = {
  action: 'Action stage',
  minor: 'Minor flooding',
  moderate: 'Moderate flooding',
  major: 'Major flooding'
};

// Classifies the current USGS level against the NWS stages directly, so the
// badge always agrees with the chart (NWS's own status can lag or read
// "obs_not_current" when its ingest falls behind).
const FloodStatus = ({ flood, level }) => {
  if (flood === null) {
    return <div className="text-xs text-gray-500">Not an NWS flood forecast point</div>;
  }
  if (flood.error) {
    return <div className="text-xs text-gray-500">Flood stages unavailable right now</div>;
  }
  if (flood.stages.length === 0 || level === null) {
    return <div className="text-xs text-gray-500">No flood stages defined</div>;
  }

  const reached = [...flood.stages].reverse().find((s) => level >= s.stage);
  const next = flood.stages.find((s) => level < s.stage);
  const color = reached ? STAGE_STYLES[reached.level].color : '#0ca30c';

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-900 whitespace-nowrap">
        <StatusIcon ok={!reached} color={color} />
        {reached ? FLOOD_LABELS[reached.level] : 'Below flood stage'}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-gray-500">
        {next ? (
          <>
            <div>
              {STAGE_STYLES[next.level].label} at {next.stage} ft
            </div>
            <div>{(next.stage - level).toFixed(1)} ft of headroom</div>
          </>
        ) : (
          'Above major flood stage'
        )}
      </div>
    </div>
  );
};

const StationPopup = ({ station, phColor, onLayout }) => {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchStationDetail(station.id)
      .then((d) => !cancelled && setDetail(d))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [station.id]);

  // The popup grows once data arrives; let Leaflet re-measure and re-pan.
  useEffect(() => {
    if (onLayout) onLayout();
  }, [detail, error, onLayout]);

  const readings = detail?.readings || {};
  const gage = readings.gageHeight;
  const latestOf = (key) => {
    const points = readings[key];
    return points ? points[points.length - 1].v : null;
  };
  const level = gage ? gage[gage.length - 1].v : null;
  const gageDayAgo = gage ? valueDayAgo(gage) : null;
  const flood = detail?.flood;

  const forecast = flood && !flood.error ? flood.forecast : [];
  const futureForecast = gage ? forecast.filter((p) => p.t > gage[gage.length - 1].t) : [];
  const crest = futureForecast.length
    ? futureForecast.reduce((a, b) => (b.v > a.v ? b : a))
    : null;

  const discharge = readings.discharge;
  const dischargeDayAgo = discharge ? valueDayAgo(discharge) : null;
  const tempC = latestOf('waterTemp');
  const dissolvedOxygen = latestOf('dissolvedOxygen');

  const qualifierLabels = station.qualifiers.filter((q) => QUALIFIER_LABELS[q]);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="pr-6">
        <h3 className="text-[15px] font-semibold leading-snug text-gray-900">
          {prettifySiteName(station.name)}
        </h3>
        <div className="mt-1 text-[11px] text-gray-500">
          USGS {station.id} &middot; {station.lat.toFixed(4)}, {station.lon.toFixed(4)}
        </div>
      </div>

      {/* Headline: pH + flood status */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
          <div className="text-[10px] tracking-wide text-gray-500">pH</div>
          <div className="flex items-baseline gap-2">
            <span
              className={`text-2xl font-bold tabular-nums ${station.isStale ? 'text-gray-400' : 'text-gray-900'}`}
            >
              {station.ph.toFixed(2)}
            </span>
            <span className="flex items-center gap-1 text-[11px] text-gray-600">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: phColor }} />
              {station.isStale ? 'Stale' : phCategory(station.ph)}
            </span>
          </div>
          <div className="text-[11px] text-gray-500">{formatSampleAge(station.ageMs)} ago</div>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Flood risk</div>
          {detail ? (
            <FloodStatus flood={flood} level={level} />
          ) : (
            <div className="h-9 rounded bg-gray-200 animate-pulse" />
          )}
        </div>
      </div>

      {station.isStale && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          This pH sensor hasn&rsquo;t reported in over {STALE_AFTER_DAYS} days &mdash; not current conditions.
        </div>
      )}

      {/* Water level */}
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <div className="text-xs font-semibold text-gray-800">Water level &middot; 7 days</div>
          {gage && (
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-gray-900 tabular-nums">{level.toFixed(2)} ft</span>
              <Trend
                delta={gageDayAgo === null ? null : level - gageDayAgo}
                format={(d) => `${d.toFixed(2)} ft`}
              />
            </div>
          )}
        </div>
        {error ? (
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-red-700">
            Couldn&rsquo;t load station history: {error}
          </div>
        ) : !detail ? (
          <div className="h-[150px] rounded-lg bg-gray-50 animate-pulse" />
        ) : gage && gage.length > 1 ? (
          <>
            <WaterLevelChart observed={gage} forecast={forecast} stages={flood && !flood.error ? flood.stages : []} />
            {crest && (
              <div className="mt-1 text-[11px] text-gray-500">
                NWS forecast crest{' '}
                <span className="text-gray-800 font-medium">{crest.v.toFixed(1)} ft</span>{' '}
                {new Date(crest.t).toLocaleString([], { weekday: 'short', hour: 'numeric' })}
              </div>
            )}
          </>
        ) : (
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-gray-500">
            No water level sensor at this site.
          </div>
        )}
      </div>

      {/* Other water quality readings */}
      {detail && (
        <div className="grid grid-cols-3 gap-2">
          {discharge && (
            <Tile label="Streamflow" value={Math.round(latestOf('discharge')).toLocaleString()} unit="cfs">
              {dischargeDayAgo > 0 && (
                <Trend
                  delta={((latestOf('discharge') - dischargeDayAgo) / dischargeDayAgo) * 100}
                  format={(d) => `${Math.round(d)}%`}
                />
              )}
            </Tile>
          )}
          {tempC !== null && (
            <Tile label="Water temp" value={(tempC * 9 / 5 + 32).toFixed(0)} unit="°F">
              <span className="text-[11px] text-gray-500">{tempC.toFixed(1)} °C</span>
            </Tile>
          )}
          {dissolvedOxygen !== null && (
            <Tile label="Oxygen" value={dissolvedOxygen.toFixed(1)} unit="mg/L">
              {/* 5 mg/L is the common minimum for warm-water aquatic life. */}
              {dissolvedOxygen < 5 && <span className="text-[11px] text-amber-700">Low for fish</span>}
            </Tile>
          )}
        </div>
      )}

      {qualifierLabels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {qualifierLabels.map((q) => (
            <span key={q} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
              {QUALIFIER_LABELS[q]}
            </span>
          ))}
        </div>
      )}

      {/* Sources */}
      <div className="flex items-center gap-3 pt-3 border-t border-gray-100 text-[11px]">
        <a
          href={`https://waterdata.usgs.gov/monitoring-location/USGS-${station.id}/`}
          target="_blank"
          rel="noreferrer"
        >
          USGS station &rarr;
        </a>
        {flood?.lid && (
          <a href={`https://water.noaa.gov/gauges/${flood.lid}`} target="_blank" rel="noreferrer">
            NWS hydrograph &rarr;
          </a>
        )}
        <span className="ml-auto text-gray-400">Provisional data</span>
      </div>
    </div>
  );
};

export default StationPopup;
