import React, { useRef, useState } from 'react';

// Drawn in viewBox units; the SVG scales to the popup width.
const W = 312;
const H = 150;
const M = { top: 10, right: 8, bottom: 20, left: 32 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const SERIES_COLOR = '#2a78d6';
const GRID_COLOR = '#e5e7eb';
const MUTED_INK = '#6b7280';
const SURFACE = '#ffffff';

// Follows the NWS hydrograph convention so the colors match what readers see
// on water.noaa.gov. Each line is also labelled, so color never stands alone.
// The bright line colors are too faint as text on white, so labels use a
// darker step of the same hue.
export const STAGE_STYLES = {
  action: { label: 'Action', color: '#fab219', text: '#a16207' },
  minor: { label: 'Minor flood', color: '#ec835a', text: '#c2410c' },
  moderate: { label: 'Moderate flood', color: '#d03b3b', text: '#b91c1c' },
  major: { label: 'Major flood', color: '#a855f7', text: '#7e22ce' }
};

// A gap longer than this in the 15-minute record is a sensor outage; the line
// breaks there instead of drawing a straight bridge across missing data.
const GAP_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const niceStep = (range, targetTicks) => {
  const raw = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
};

// NWS forecasts are 6-hourly, so only the observed record is checked for gaps.
const buildPath = (points, x, y, breakGaps = true) => {
  let d = '';
  points.forEach((p, i) => {
    const gap = breakGaps && i > 0 && p.t - points[i - 1].t > GAP_MS;
    d += `${i === 0 || gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
  });
  return d;
};

const formatTime = (t) =>
  new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const WaterLevelChart = ({ observed, forecast = [], stages = [] }) => {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  const last = observed[observed.length - 1];
  // Only forecast points past the last observation are a projection.
  const future = forecast.filter((p) => p.t > last.t);
  const forecastLine = future.length ? [last, ...future] : [];
  const all = [...observed, ...future];

  const tMin = observed[0].t;
  const tMax = all[all.length - 1].t;
  let vMin = Math.min(...all.map((p) => p.v));
  let vMax = Math.max(...all.map((p) => p.v));
  const range = Math.max(vMax - vMin, 0.5);

  // Stretch the axis to the next flood stage above the data when it's close
  // enough to matter, so the reader sees the headroom. A stage far above
  // (e.g. 20 ft away on a 1 ft wiggle) would flatten the line to nothing; the
  // popup states that distance in text instead.
  const nextStage = stages.find((s) => s.stage > vMax);
  if (nextStage && nextStage.stage - vMax <= Math.max(3 * range, 4)) {
    vMax = nextStage.stage;
  }
  const pad = Math.max((vMax - vMin) * 0.12, 0.25);
  const step = niceStep(vMax - vMin + 2 * pad, 4);
  const yLo = Math.floor((vMin - pad) / step) * step;
  const yHi = Math.ceil((vMax + pad) / step) * step;

  const x = (t) => M.left + ((t - tMin) / (tMax - tMin || 1)) * PLOT_W;
  const y = (v) => M.top + (1 - (v - yLo) / (yHi - yLo)) * PLOT_H;

  const yTicks = [];
  for (let v = yLo; v <= yHi + step / 2; v += step) yTicks.push(v);
  // As many decimals as the step has, so 0.25-ft ticks don't round together.
  const decimals = (String(+step.toFixed(4)).split('.')[1] || '').length;

  // Midnight ticks, thinned so labels never collide.
  const dayTicks = [];
  const firstMidnight = new Date(tMin);
  firstMidnight.setHours(24, 0, 0, 0);
  for (let t = firstMidnight.getTime(); t <= tMax; t += DAY_MS) dayTicks.push(t);
  const every = Math.ceil(dayTicks.length / 7);
  const shownDayTicks = dayTicks.filter((_, i) => i % every === 0);

  const visibleStages = stages.filter((s) => s.stage >= yLo && s.stage <= yHi);

  const handleMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = tMin + ((vx - M.left) / PLOT_W) * (tMax - tMin);
    let nearest = all[0];
    all.forEach((p) => {
      if (Math.abs(p.t - t) < Math.abs(nearest.t - t)) nearest = p;
    });
    setHover({ ...nearest, isForecast: nearest.t > last.t });
  };

  const hoverLeftPct = hover ? (x(hover.t) / W) * 100 : 0;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto block touch-none"
        role="img"
        aria-label={`Water level over the last 7 days, currently ${last.v.toFixed(2)} feet`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke={GRID_COLOR} strokeWidth="1" />
            <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize="9" fill={MUTED_INK}>
              {v.toFixed(decimals)}
            </text>
          </g>
        ))}

        {shownDayTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize="9" fill={MUTED_INK}>
            {new Date(t).toLocaleDateString([], { weekday: 'short' })}
          </text>
        ))}

        {forecastLine.length > 0 && (
          <g>
            <rect
              x={x(last.t)}
              y={M.top}
              width={W - M.right - x(last.t)}
              height={PLOT_H}
              fill="#111827"
              opacity="0.03"
            />
            <text x={x(last.t) + 4} y={M.top + 9} fontSize="8" fill={MUTED_INK}>
              Forecast
            </text>
          </g>
        )}

        {visibleStages.map((s) => (
          <g key={s.level}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={y(s.stage)}
              y2={y(s.stage)}
              stroke={STAGE_STYLES[s.level].color}
              strokeWidth="1"
              opacity="0.85"
            />
            <text
              x={W - M.right - 2}
              y={y(s.stage) - 3}
              textAnchor="end"
              fontSize="8"
              fill={STAGE_STYLES[s.level].text}
            >
              {STAGE_STYLES[s.level].label} {s.stage} ft
            </text>
          </g>
        ))}

        <path
          d={buildPath(observed, x, y)}
          fill="none"
          stroke={SERIES_COLOR}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {forecastLine.length > 0 && (
          <path
            d={buildPath(forecastLine, x, y, false)}
            fill="none"
            stroke={SERIES_COLOR}
            strokeWidth="2"
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
        )}

        <circle cx={x(last.t)} cy={y(last.v)} r="4" fill={SERIES_COLOR} stroke={SURFACE} strokeWidth="2" />

        {hover && (
          <g pointerEvents="none">
            <line x1={x(hover.t)} x2={x(hover.t)} y1={M.top} y2={M.top + PLOT_H} stroke={MUTED_INK} strokeWidth="1" />
            <circle cx={x(hover.t)} cy={y(hover.v)} r="4" fill={SERIES_COLOR} stroke={SURFACE} strokeWidth="2" />
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="absolute top-0 pointer-events-none rounded-md bg-white border border-gray-200 px-2 py-1 text-[11px] leading-tight whitespace-nowrap shadow-lg"
          style={{
            left: `${hoverLeftPct}%`,
            transform: `translateX(${hoverLeftPct > 60 ? 'calc(-100% - 8px)' : '8px'})`
          }}
        >
          <div className="font-semibold text-gray-900">
            {hover.v.toFixed(2)} ft{hover.isForecast && <span className="text-gray-500 font-normal"> forecast</span>}
          </div>
          <div className="text-gray-500">{formatTime(hover.t)}</div>
        </div>
      )}

      {forecastLine.length > 0 && (
        <div className="flex gap-4 mt-1 text-[10px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden="true">
              <line x1="1" x2="15" y1="2" y2="2" stroke={SERIES_COLOR} strokeWidth="2" strokeLinecap="round" />
            </svg>
            Observed (USGS)
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden="true">
              <line x1="1" x2="15" y1="2" y2="2" stroke={SERIES_COLOR} strokeWidth="2" strokeDasharray="4 3" />
            </svg>
            Forecast (NWS)
          </span>
        </div>
      )}
    </div>
  );
};

export default WaterLevelChart;
