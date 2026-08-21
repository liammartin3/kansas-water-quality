import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// A reading older than this is not "current conditions" and is shown greyed out.
const STALE_AFTER_DAYS = 7;

// How often to re-poll while the tab is open. USGS instantaneous-values data
// lands every 15-60 minutes, so a 24h timer would effectively never fire.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// USGS qualifier codes that mean the value is not a trustworthy measurement.
// 'P' (provisional) and 'A' (approved) are normal and must not be treated as bad.
const BAD_QUALIFIERS = ['Eqp', 'Mnt', 'Dis', 'Ice', '***'];

const QUALIFIER_LABELS = {
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

// Formats an elapsed duration as a bare quantity ("22 min", "3 days", "12.2 yr").
// Callers supply the label that says what the duration measures.
const formatSampleAge = (ageMs) => {
  const hours = ageMs / (60 * 60 * 1000);
  if (hours < 1) return `${Math.max(1, Math.round(ageMs / 60000))} min`;
  if (hours < 48) return `${Math.round(hours)} hr`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days} days`;
  const years = (days / 365).toFixed(1);
  return `${years} yr`;
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

  // pH color scale. Stale readings are greyed out regardless of value so a
  // long-dead sensor can't masquerade as a current alert.
  const getColorByPH = (station) => {
    if (station.isStale) return '#6b7280'; // Stale - Grey
    if (station.ph < 7) return '#e74c3c'; // Acidic - Red
    if (station.ph < 7.5) return '#2ecc71'; // Neutral - Green
    if (station.ph < 8.5) return '#3498db'; // Slightly alkaline - Blue
    return '#9b59b6'; // Alkaline - Purple
  };

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
  const visibleStations = showStale ? stations : stations.filter((s) => !s.isStale);

  const freshStations = stations.filter((s) => !s.isStale);
  const newestSample = freshStations.length
    ? new Date(Math.max(...freshStations.map((s) => s.measuredAt.getTime())))
    : null;

  const handleStationClick = (lat, lon) => {
    setFlyToCenter([lat, lon]);
    setFlyToZoom(12);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen bg-gray-900 text-white">Loading water quality data...</div>;
  }

  if (error && stations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-red-400 gap-4">
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
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            subdomains='abcd'
            maxZoom={19}
          />

          <FlyToLocation center={flyToCenter} zoom={flyToZoom} />

          {visibleStations.map((station) => (
            <CircleMarker
              key={station.id}
              center={[station.lat, station.lon]}
              radius={station.isStale ? 6 : 8}
              fillColor={getColorByPH(station)}
              color={station.isStale ? '#9ca3af' : '#fff'}
              weight={2}
              opacity={station.isStale ? 0.5 : 1}
              fillOpacity={station.isStale ? 0.35 : 0.8}
            >
              <Popup>
                <div className="text-sm">
                  <h3 className="font-bold mb-2">{station.name}</h3>
                  <p><strong>Station ID:</strong> {station.id}</p>
                  <p><strong>pH Value:</strong> {station.ph.toFixed(2)}</p>
                  <p><strong>Measured:</strong> {station.measuredAt.toLocaleString()}</p>
                  <p><strong>Sample Age:</strong> {formatSampleAge(station.ageMs)}</p>
                  <p><strong>Latitude:</strong> {station.lat.toFixed(4)}</p>
                  <p><strong>Longitude:</strong> {station.lon.toFixed(4)}</p>
                  {station.qualifiers
                    .filter((q) => QUALIFIER_LABELS[q])
                    .map((q) => (
                      <p key={q} className="text-amber-700">{QUALIFIER_LABELS[q]}</p>
                    ))}
                  {station.isStale && (
                    <p className="mt-2 font-semibold text-amber-700">
                      Stale reading &mdash; this sensor has not reported in over {STALE_AFTER_DAYS} days.
                      Not current conditions.
                    </p>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>

        {/* Legend */}
        <div className="absolute bottom-8 left-8 bg-gray-900 text-white p-4 rounded-lg shadow-lg z-[1000] border border-gray-700">
          <h3 className="font-bold mb-2 text-sm">pH Scale</h3>
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#e74c3c' }}></div>
              <span>Acidic (&lt; 7)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#2ecc71' }}></div>
              <span>Neutral (7 - 7.5)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#3498db' }}></div>
              <span>Alkaline (7.5 - 8.5)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#9b59b6' }}></div>
              <span>Highly Alkaline (&gt; 8.5)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#6b7280', opacity: 0.5 }}></div>
              <span>Stale (&gt; {STALE_AFTER_DAYS} days old)</span>
            </div>
          </div>
          <div className="text-xs mt-3 pt-2 border-t border-gray-700 text-gray-400 space-y-0.5">
            <p>Newest sample: {newestSample ? newestSample.toLocaleString() : 'none current'}</p>
            <p>Page refreshed: {fetchedAt ? fetchedAt.toLocaleString() : '—'}</p>
          </div>
        </div>
      </div>

      {/* Side Panel - Acidic Stations */}
      <div className="w-80 bg-gray-900 text-white p-6 overflow-y-auto border-l border-gray-700">
        <h2 className="text-xl font-bold mb-4">Acidic Stations</h2>
        <p className="text-sm text-gray-400 mb-4">
          Current readings with pH &lt; 7 (sorted by acidity). Sensors that have not reported
          in {STALE_AFTER_DAYS} days are excluded.
        </p>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 p-3 rounded-lg text-xs mb-4">
            {error} Showing last known data.
          </div>
        )}

        {acidicStations.length === 0 ? (
          <div className="bg-gray-800 p-4 rounded-lg border border-gray-700 text-center text-gray-400">
            No acidic stations found
          </div>
        ) : (
          <div className="space-y-3">
            {acidicStations.map((station, index) => (
              <div
                key={station.id}
                className="bg-gray-800 p-4 rounded-lg shadow border border-gray-700 cursor-pointer hover:bg-gray-700 hover:border-red-500 transition-all"
                onClick={() => handleStationClick(station.lat, station.lon)}
              >
                <div className="flex items-start gap-2">
                  <div className="text-lg font-bold text-red-400">#{index + 1}</div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-sm mb-2">{station.name}</h3>
                    <div className="text-xs space-y-1 text-gray-300">
                      <p><strong>pH:</strong> <span className="text-red-400 font-bold">{station.ph.toFixed(2)}</span></p>
                      <p><strong>Station ID:</strong> {station.id}</p>
                      <p><strong>Sample Age:</strong> {formatSampleAge(station.ageMs)}</p>
                      <p className="text-gray-500 text-xs mt-1">Click to zoom to location</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-sm">Stale sensors</h3>
              <p className="text-xs text-gray-400 mt-1">
                {staleCount} of {stations.length} stations have not reported in
                over {STALE_AFTER_DAYS} days.
              </p>
            </div>
            <label className="flex items-center gap-1 text-xs text-gray-300 shrink-0">
              <input
                type="checkbox"
                checked={showStale}
                onChange={(e) => setShowStale(e.target.checked)}
              />
              Show
            </label>
          </div>
        </div>

        <div className="mt-4 p-4 bg-gray-800 rounded-lg border border-gray-700">
          <h3 className="font-semibold text-sm mb-2">About pH</h3>
          <p className="text-xs text-gray-300">
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
