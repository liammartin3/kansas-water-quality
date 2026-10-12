import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import StationPopup from './StationPopup';
import { STALE_AFTER_DAYS, BAD_QUALIFIERS, formatSampleAge } from './usgs';

// How often to re-poll while the tab is open. USGS instantaneous-values data
// lands every 15-60 minutes, so a 24h timer would effectively never fire.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Component to handle map flying to location
const FlyToLocation = ({ center, zoom }) => {
  const map = useMap();

  useEffect(() => {
    if (center) {
      map.flyTo(center, zoom, {
        duration: 1.5
      });
    }
  }, [center, zoom, map]);

  return null;
};

// pH classes, lowest first. Blue is deliberately absent: on the hydrography
// basemap blue means water, so a blue marker vanishes into its own river.
// Validated for separation and contrast against the light-gray basemap.
const PH_CLASSES = [
  { max: 7, color: '#e4572e', label: 'Acidic (< 7)' },
  { max: 7.5, color: '#15803d', label: 'Neutral (7 - 7.5)' },
  { max: Infinity, color: '#8b5cf6', label: 'Alkaline (> 7.5)' }
];

const STALE_COLOR = '#6b7280';

// Stale readings are greyed out regardless of value so a long-dead sensor
// can't masquerade as a current alert.
const getColorByPH = (station) =>
  station.isStale ? STALE_COLOR : PH_CLASSES.find((c) => station.ph < c.max).color;

// Fresh stations are solid dots with a dark outline, which reads on both the
// gray land and the blue rivers. Stale stations are hollow rings: a shape
// change says "no current reading" where a gray fill on gray land would not.
// Acidic dots are larger because they are the alert this map exists for.
const markerStyle = (station) => {
  if (station.isStale) {
    return { radius: 6, fillColor: '#ffffff', fillOpacity: 0.9, color: STALE_COLOR, weight: 2 };
  }
  return {
    radius: station.ph < 7 ? 10 : 8,
    fillColor: getColorByPH(station),
    fillOpacity: 0.95,
    color: '#1f2937',
    weight: 1.5
  };
};

// The popup's content mounts only while it is open, so its week of history is
// fetched on demand rather than for every station up front.
const StationMarker = ({ station }) => {
  const popupRef = useRef(null);
  const [open, setOpen] = useState(false);
  const relayout = useCallback(() => popupRef.current?.update(), []);
  const color = getColorByPH(station);

  return (
    <CircleMarker
      center={[station.lat, station.lon]}
      {...markerStyle(station)}
      eventHandlers={{
        popupopen: () => setOpen(true),
        popupclose: () => setOpen(false)
      }}
    >
      <Popup ref={popupRef} className="station-popup" minWidth={340} maxWidth={340}>
        {open && <StationPopup station={station} phColor={color} onLayout={relayout} />}
      </Popup>
    </CircleMarker>
  );
};

const KansasWaterQuality = () => {
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [flyToCenter, setFlyToCenter] = useState(null);
  const [flyToZoom, setFlyToZoom] = useState(7);
  const [showStale, setShowStale] = useState(true);

  // A timeSeries can carry several value blocks (different sensors/methods at
  // the same site). Block 0 is sometimes a discontinued sensor returning the
  // -999999 no-data sentinel while a later block holds a good reading, so scan
  // them all and keep the most recent valid one.
  const pickBestReading = (series) => {
    let best = null;

    (series.values || []).forEach((block) => {
      const values = block.value || [];
      if (values.length === 0) return;

      const latest = values[values.length - 1];
      const ph = parseFloat(latest.value);

      // Rejects the -999999 sentinel, nulls and NaN. Number.isFinite avoids the
      // falsy-zero trap of a plain `!ph` check.
      if (!Number.isFinite(ph) || ph < 0 || ph > 14) return;

      const qualifiers = latest.qualifiers || [];
      if (qualifiers.some((q) => BAD_QUALIFIERS.includes(q))) return;

      const measuredAt = new Date(latest.dateTime);
      if (isNaN(measuredAt.getTime())) return;

      if (!best || measuredAt > best.measuredAt) {
        best = { ph, measuredAt, qualifiers };
      }
    });

    return best;
  };

  const fetchWaterQualityData = useCallback(async (isInitial = false) => {
    try {
      if (isInitial) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      // Clear any previous failure so a successful retry recovers the UI.
      setError(null);

      const response = await fetch(
        'https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=00400&stateCd=KS&siteStatus=active'
      );

      if (!response.ok) {
        throw new Error(`USGS returned ${response.status}`);
      }

      const data = await response.json();

      if (data.value && data.value.timeSeries) {
        const now = Date.now();

        const processedStations = data.value.timeSeries
          .map((series) => {
            const site = series.sourceInfo;
            const reading = pickBestReading(series);

            if (!reading) return null;

            const lat = parseFloat(site.geoLocation.geogLocation.latitude);
            const lon = parseFloat(site.geoLocation.geogLocation.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

            const ageMs = now - reading.measuredAt.getTime();

            return {
              id: site.siteCode[0].value,
              name: site.siteName,
              lat,
              lon,
              ph: reading.ph,
              measuredAt: reading.measuredAt,
              ageMs,
              isStale: ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
              qualifiers: reading.qualifiers
            };
          })
          .filter((station) => station !== null);

        setStations(processedStations);
        setFetchedAt(new Date());
      }
    } catch (err) {
      setError(`Failed to fetch water quality data: ${err.message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchWaterQualityData(true);

    const interval = setInterval(() => {
      fetchWaterQualityData();
    }, REFRESH_INTERVAL_MS);

    // A background tab can throttle timers for hours, so also refresh whenever
    // the user comes back to the page.
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchWaterQualityData();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchWaterQualityData]);

  // Only current readings count as an acidic alert.
  const acidicStations = [...stations]
    .filter((station) => station.ph < 7 && !station.isStale)
    .sort((a, b) => a.ph - b.ph);

  const staleCount = stations.filter((s) => s.isStale).length;
  // Leaflet stacks markers in the order they're added, so draw stale rings
  // first and acidic dots last to keep alerts on top where stations cluster.
  const drawOrder = (s) => (s.isStale ? 0 : s.ph < 7 ? 2 : 1);
  const visibleStations = (showStale ? stations : stations.filter((s) => !s.isStale))
    .slice()
    .sort((a, b) => drawOrder(a) - drawOrder(b));

  const freshStations = stations.filter((s) => !s.isStale);
  const newestSample = freshStations.length
    ? new Date(Math.max(...freshStations.map((s) => s.measuredAt.getTime())))
    : null;

  const handleStationClick = (lat, lon) => {
    setFlyToCenter([lat, lon]);
    setFlyToZoom(12);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen bg-white text-gray-900">Loading water quality data...</div>;
  }

  if (error && stations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 text-red-600 gap-4">
        <p>{error}</p>
        <button
          onClick={() => fetchWaterQualityData(true)}
          className="bg-blue-600 text-white py-2 px-6 rounded hover:bg-blue-700 transition-colors text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {/* Map Section */}
      <div className="flex-1 relative">
        <MapContainer
          center={[38.5, -98.0]}
          zoom={7}
          style={{ height: '100%', width: '100%' }}
        >
          {/* Esri's light canvas: keyless and free, unlike CARTO which now meters
              anonymous use. Esri serves {z}/{y}/{x} order and its deepest native
              tile is z16, so overzoom is upscaled rather than 404ing. */}
          <TileLayer
            attribution='Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin | Hydrography: <a href="https://www.usgs.gov/national-hydrography">USGS NHD</a>'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={16}
            maxZoom={19}
          />
          {/* USGS National Hydrography: transparent rivers, streams and lakes with
              river names, so each station visibly sits on the water it samples. */}
          <TileLayer
            url="https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}"
            opacity={0.6}
            maxNativeZoom={16}
            maxZoom={19}
          />
          {/* Place names ship as a separate overlay on Esri's canvas basemaps. */}
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={16}
            maxZoom={19}
          />

          <FlyToLocation center={flyToCenter} zoom={flyToZoom} />

          {visibleStations.map((station) => (
            <StationMarker key={station.id} station={station} />
          ))}
        </MapContainer>

        {/* Legend */}
        <div className="absolute bottom-8 left-8 bg-white text-gray-900 p-4 rounded-lg shadow-lg z-[1000] border border-gray-200">
          <h3 className="font-bold mb-2 text-sm">pH Scale</h3>
          <div className="space-y-1 text-xs">
            {PH_CLASSES.map((c) => (
              <div key={c.label} className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded-full border-[1.5px] border-gray-800"
                  style={{ backgroundColor: c.color }}
                ></div>
                <span>{c.label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-2 bg-white" style={{ borderColor: STALE_COLOR }}></div>
              <span>Stale (&gt; {STALE_AFTER_DAYS} days old)</span>
            </div>
          </div>
          <div className="text-xs mt-3 pt-2 border-t border-gray-200 text-gray-500 space-y-0.5">
            <p>Newest sample: {newestSample ? newestSample.toLocaleString() : 'none current'}</p>
            <p>Page refreshed: {fetchedAt ? fetchedAt.toLocaleString() : '—'}</p>
          </div>
        </div>
      </div>

      {/* Side Panel - Acidic Stations */}
      <div className="w-80 bg-white text-gray-900 p-6 overflow-y-auto border-l border-gray-200">
        <h2 className="text-xl font-bold mb-4">Acidic Stations</h2>
        <p className="text-sm text-gray-500 mb-4">
          Current readings with pH &lt; 7 (sorted by acidity). Sensors that have not reported
          in {STALE_AFTER_DAYS} days are excluded.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-xs mb-4">
            {error} Showing last known data.
          </div>
        )}

        {acidicStations.length === 0 ? (
          <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 text-center text-gray-500">
            No acidic stations found
          </div>
        ) : (
          <div className="space-y-3">
            {acidicStations.map((station, index) => (
              <div
                key={station.id}
                className="bg-gray-50 p-4 rounded-lg shadow border border-gray-200 cursor-pointer hover:bg-white hover:border-red-300 transition-all"
                onClick={() => handleStationClick(station.lat, station.lon)}
              >
                <div className="flex items-start gap-2">
                  <div className="text-lg font-bold text-red-600">#{index + 1}</div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-sm mb-2">{station.name}</h3>
                    <div className="text-xs space-y-1 text-gray-600">
                      <p><strong>pH:</strong> <span className="text-red-600 font-bold">{station.ph.toFixed(2)}</span></p>
                      <p><strong>Station ID:</strong> {station.id}</p>
                      <p><strong>Sample Age:</strong> {formatSampleAge(station.ageMs)}</p>
                      <p className="text-gray-400 text-xs mt-1">Click to zoom to location</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-sm">Stale sensors</h3>
              <p className="text-xs text-gray-500 mt-1">
                {staleCount} of {stations.length} stations have not reported in
                over {STALE_AFTER_DAYS} days.
              </p>
            </div>
            <label className="flex items-center gap-1 text-xs text-gray-600 shrink-0">
              <input
                type="checkbox"
                checked={showStale}
                onChange={(e) => setShowStale(e.target.checked)}
              />
              Show
            </label>
          </div>
        </div>

        <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h3 className="font-semibold text-sm mb-2">About pH</h3>
          <p className="text-xs text-gray-600">
            pH measures water acidity/alkalinity. Most aquatic life thrives between 6.5-8.5.
            Values below 7 are acidic and may indicate pollution or environmental stress.
          </p>
        </div>

        <button
          onClick={() => fetchWaterQualityData()}
          disabled={refreshing}
          className="mt-4 w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm"
        >
          {refreshing ? 'Refreshing...' : 'Refresh Data'}
        </button>
      </div>
    </div>
  );
};

export default KansasWaterQuality;
