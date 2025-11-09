import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

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

const KansasWaterQuality = () => {
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [flyToCenter, setFlyToCenter] = useState(null);
  const [flyToZoom, setFlyToZoom] = useState(7);

  // pH color scale
  const getColorByPH = (ph) => {
    if (ph < 7) return '#e74c3c'; // Acidic - Red
    if (ph >= 7 && ph < 7.5) return '#2ecc71'; // Neutral - Green
    if (ph >= 7.5 && ph < 8.5) return '#3498db'; // Slightly alkaline - Blue
    return '#9b59b6'; // Alkaline - Purple
  };

  const fetchWaterQualityData = async () => {
    try {
      setLoading(true);
      const response = await fetch(
        'https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=00400&stateCd=KS&siteStatus=active'
      );
      const data = await response.json();

      if (data.value && data.value.timeSeries) {
        const processedStations = data.value.timeSeries
          .map((series) => {
            const site = series.sourceInfo;
            const values = series.values[0]?.value;
            
            if (!values || values.length === 0) return null;
            
            const latestValue = values[values.length - 1];
            const ph = parseFloat(latestValue.value);
            
            // Filter out invalid pH values (null, NaN, negative, or unrealistic values)
            if (!ph || isNaN(ph) || ph < 0 || ph > 14 || ph < -1000) {
              return null;
            }
            
            return {
              id: site.siteCode[0].value,
              name: site.siteName,
              lat: parseFloat(site.geoLocation.geogLocation.latitude),
              lon: parseFloat(site.geoLocation.geogLocation.longitude),
              ph: ph,
              dateTime: latestValue.dateTime
            };
          })
          .filter(station => station !== null);

        setStations(processedStations);
        setLastUpdated(new Date().toLocaleString());
      }
      setLoading(false);
    } catch (err) {
      setError('Failed to fetch water quality data');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWaterQualityData();
    
    // Fetch data once per day (24 hours)
    const interval = setInterval(() => {
      fetchWaterQualityData();
    }, 24 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  // Get stations with pH < 7 (acidic)
  const getAcidicStations = () => {
    return [...stations]
      .filter(station => station.ph < 7)
      .sort((a, b) => a.ph - b.ph);
  };

  const handleStationClick = (lat, lon) => {
    setFlyToCenter([lat, lon]);
    setFlyToZoom(12);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen bg-gray-900 text-white">Loading water quality data...</div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-screen bg-gray-900 text-red-400">{error}</div>;
  }

  const acidicStations = getAcidicStations();

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
          
          {stations.map((station) => (
            <CircleMarker
              key={station.id}
              center={[station.lat, station.lon]}
              radius={8}
              fillColor={getColorByPH(station.ph)}
              color="#fff"
              weight={2}
              opacity={1}
              fillOpacity={0.8}
            >
              <Popup>
                <div className="text-sm">
                  <h3 className="font-bold mb-2">{station.name}</h3>
                  <p><strong>Station ID:</strong> {station.id}</p>
                  <p><strong>pH Value:</strong> {station.ph.toFixed(2)}</p>
                  <p><strong>Latitude:</strong> {station.lat.toFixed(4)}</p>
                  <p><strong>Longitude:</strong> {station.lon.toFixed(4)}</p>
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
          </div>
          <p className="text-xs mt-2 text-gray-400">Last updated: {lastUpdated}</p>
        </div>
      </div>

      {/* Side Panel - Acidic Stations */}
      <div className="w-80 bg-gray-900 text-white p-6 overflow-y-auto border-l border-gray-700">
        <h2 className="text-xl font-bold mb-4">Acidic Stations</h2>
        <p className="text-sm text-gray-400 mb-4">Stations with pH &lt; 7 (sorted by acidity)</p>
        
        {acidicStations.length === 0 ? (
          <div className="bg-gray-800 p-4 rounded-lg border border-gray-700 text-center text-gray-400">
            No acidic stations found
          </div>
        ) : (
          <div className="space-y-3">
            {acidicStations.map((station, index) => (
              <div 
                key={station.id} 
                className="bg-gray-800 p-4 rounded-lg shadow border border-gray-700 cursor-pointer hover:bg-gray-750 hover:border-red-500 transition-all"
                onClick={() => handleStationClick(station.lat, station.lon)}
              >
                <div className="flex items-start gap-2">
                  <div className="text-lg font-bold text-red-400">#{index + 1}</div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-sm mb-2">{station.name}</h3>
                    <div className="text-xs space-y-1 text-gray-300">
                      <p><strong>pH:</strong> <span className="text-red-400 font-bold">{station.ph.toFixed(2)}</span></p>
                      <p><strong>Station ID:</strong> {station.id}</p>
                      <p className="text-gray-500 text-xs mt-1">Click to zoom to location</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
          <h3 className="font-semibold text-sm mb-2">About pH</h3>
          <p className="text-xs text-gray-300">
            pH measures water acidity/alkalinity. Most aquatic life thrives between 6.5-8.5. 
            Values below 7 are acidic and may indicate pollution or environmental stress.
          </p>
        </div>

        <button
          onClick={fetchWaterQualityData}
          className="mt-4 w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 transition-colors text-sm"
        >
          Refresh Data
        </button>
      </div>
    </div>
  );
};

export default KansasWaterQuality;