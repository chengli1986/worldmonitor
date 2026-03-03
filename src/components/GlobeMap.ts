/**
 * GlobeMap - 3D interactive globe using globe.gl
 *
 * Matches WorldMonitor's MapContainer API so it can be used as a drop-in
 * replacement within MapContainer when the user enables globe mode.
 *
 * Architecture mirrors Sentinel (sentinel.axonia.us):
 *  - globe.gl v2 (new Globe(element, config))
 *  - Earth texture: /textures/earth-topo-bathy.jpg
 *  - Night sky background: /textures/night-sky.png
 *  - Specular/water map: /textures/earth-water.png
 *  - Atmosphere: #4466cc glow via built-in Fresnel shader
 *  - All markers via htmlElementsData (single merged array with _kind discriminator)
 *  - Auto-rotate after 60 s of inactivity
 */

import Globe from 'globe.gl';
import type { GlobeInstance, ConfigOptions } from 'globe.gl';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { getCountryBbox } from '@/services/country-geometry';
import type { MapLayers, Hotspot, MilitaryFlight, MilitaryVessel, NaturalEvent, InternetOutage, CyberThreat, SocialUnrestEvent } from '@/types';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { WeatherAlert } from '@/services/weather';
import type { IranEvent } from '@/services/conflict';

// ─── Marker discriminated union ─────────────────────────────────────────────
interface BaseMarker {
  _kind: string;
  _lat: number;
  _lng: number;
}
interface ConflictMarker extends BaseMarker {
  _kind: 'conflict';
  id: string;
  fatalities: number;
  eventType: string;
  location: string;
}
interface HotspotMarker extends BaseMarker {
  _kind: 'hotspot';
  id: string;
  name: string;
  escalationScore: number;
}
interface FlightMarker extends BaseMarker {
  _kind: 'flight';
  id: string;
  callsign: string;
  type: string;
  heading: number;
}
interface VesselMarker extends BaseMarker {
  _kind: 'vessel';
  id: string;
  name: string;
  type: string;
}
interface WeatherMarker extends BaseMarker {
  _kind: 'weather';
  id: string;
  severity: string;
  headline: string;
}
interface NaturalMarker extends BaseMarker {
  _kind: 'natural';
  id: string;
  category: string;
  title: string;
}
interface IranMarker extends BaseMarker {
  _kind: 'iran';
  id: string;
  title: string;
  category: string;
  severity: string;
  location: string;
}
interface OutageMarker extends BaseMarker {
  _kind: 'outage';
  id: string;
  title: string;
  severity: string;
  country: string;
}
interface CyberMarker extends BaseMarker {
  _kind: 'cyber';
  id: string;
  indicator: string;
  severity: string;
  type: string;
}
interface FireMarker extends BaseMarker {
  _kind: 'fire';
  id: string;
  region: string;
  brightness: number;
}
interface ProtestMarker extends BaseMarker {
  _kind: 'protest';
  id: string;
  title: string;
  eventType: string;
  country: string;
}
type GlobeMarker =
  | ConflictMarker | HotspotMarker | FlightMarker | VesselMarker
  | WeatherMarker | NaturalMarker | IranMarker | OutageMarker
  | CyberMarker | FireMarker | ProtestMarker;

export class GlobeMap {
  private container: HTMLElement;
  private globe: GlobeInstance | null = null;
  private initialized = false;
  private destroyed = false;

  // Current data
  private conflicts: ConflictMarker[] = [];
  private hotspots: HotspotMarker[] = [];
  private flights: FlightMarker[] = [];
  private vessels: VesselMarker[] = [];
  private weatherMarkers: WeatherMarker[] = [];
  private naturalMarkers: NaturalMarker[] = [];
  private iranMarkers: IranMarker[] = [];
  private outageMarkers: OutageMarker[] = [];
  private cyberMarkers: CyberMarker[] = [];
  private fireMarkers: FireMarker[] = [];
  private protestMarkers: ProtestMarker[] = [];

  // Current layers state
  private layers: MapLayers;
  private timeRange: TimeRange;
  private currentView: MapView = 'global';

  // Click callbacks
  private onHotspotClickCb: ((h: Hotspot) => void) | null = null;

  // Auto-rotate timer (like Sentinel: resume after 60 s idle)
  private autoRotateTimer: ReturnType<typeof setTimeout> | null = null;

  // ResizeObserver keeps the canvas in sync with the container
  private resizeObserver: ResizeObserver | null = null;

  // Overlay UI elements
  private layerTogglesEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;

  // Callbacks
  private onLayerChangeCb: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;

  constructor(container: HTMLElement, initialState: MapContainerState) {
    this.container = container;
    this.layers = { ...initialState.layers };
    this.timeRange = initialState.timeRange;
    this.currentView = initialState.view;

    this.container.classList.add('globe-mode');
    this.container.style.cssText = 'width:100%;height:100%;background:#000;position:relative;';

    this.initGlobe().catch(err => {
      console.error('[GlobeMap] Init failed:', err);
    });
  }

  private async initGlobe(): Promise<void> {
    if (this.destroyed) return;

    const config: ConfigOptions = {
      animateIn: false,
      rendererConfig: { logarithmicDepthBuffer: true },
    };

    const globe = new Globe(this.container, config) as GlobeInstance;

    if (this.destroyed) {
      globe._destructor();
      return;
    }

    // Initial sizing: use container dimensions, fall back to window if not yet laid out
    const initW = this.container.clientWidth || window.innerWidth;
    const initH = this.container.clientHeight || window.innerHeight;

    globe
      .globeImageUrl('/textures/earth-topo-bathy.jpg')
      .backgroundImageUrl('/textures/night-sky.png')
      .atmosphereColor('#4466cc')
      .atmosphereAltitude(0.18)
      .width(initW)
      .height(initH)
      .pathTransitionDuration(0);

    // Orbit controls — match Sentinel's settings
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.zoomSpeed = 1.4;
    controls.minDistance = 101;
    controls.maxDistance = 600;
    controls.enableDamping = true;

    // Force the canvas to visually fill the container so it expands with CSS transitions.
    // globe.gl sets explicit width/height attributes; we override the CSS so the canvas
    // always covers the full container even before the next renderer resize fires.
    const glCanvas = this.container.querySelector('canvas');
    if (glCanvas) {
      (glCanvas as HTMLElement).style.cssText =
        'position:absolute;top:0;left:0;width:100% !important;height:100% !important;';
    }

    // ResizeObserver: whenever the container grows or shrinks (fullscreen toggle,
    // drag-resize, window resize), update the globe.gl renderer dimensions.
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.globe || this.destroyed) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w > 0 && h > 0) this.globe.width(w).height(h);
    });
    this.resizeObserver.observe(this.container);

    // Load specular/water map for ocean shimmer
    setTimeout(async () => {
      try {
        const material = globe.globeMaterial();
        if (material) {
          const { TextureLoader, Color } = await import('three');
          new TextureLoader().load('/textures/earth-water.png', (tex: any) => {
            (material as any).specularMap = tex;
            (material as any).specular = new Color(2767434);
            (material as any).shininess = 30;
            material.needsUpdate = true;
          });
          (material as any).bumpScale = 3;
          material.needsUpdate = true;
        }
      } catch {
        // specular map is cosmetic — ignore
      }
    }, 800);

    // Pause auto-rotate on user interaction; resume after 60 s idle (like Sentinel)
    const pauseAutoRotate = () => {
      controls.autoRotate = false;
      if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    };
    const scheduleResumeAutoRotate = () => {
      if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
      this.autoRotateTimer = setTimeout(() => {
        controls.autoRotate = true;
      }, 60_000);
    };

    const canvas = this.container.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('mousedown', pauseAutoRotate);
      canvas.addEventListener('touchstart', pauseAutoRotate, { passive: true });
      canvas.addEventListener('mouseup', scheduleResumeAutoRotate);
      canvas.addEventListener('touchend', scheduleResumeAutoRotate);
    }

    // Wire HTML marker layer
    globe
      .htmlElementsData([])
      .htmlLat((d: object) => (d as GlobeMarker)._lat)
      .htmlLng((d: object) => (d as GlobeMarker)._lng)
      .htmlAltitude((d: object) => {
        const m = d as GlobeMarker;
        if (m._kind === 'flight' || m._kind === 'vessel') return 0.012;
        if (m._kind === 'hotspot') return 0.005;
        return 0.003;
      })
      .htmlElement((d: object) => this.buildMarkerElement(d as GlobeMarker));

    this.globe = globe;
    this.initialized = true;

    // Add overlay UI (zoom controls + layer panel)
    this.createControls();
    this.createLayerToggles();

    // Load static datasets
    this.setHotspots(INTEL_HOTSPOTS);
    this.setConflictZones();

    // Navigate to initial view
    this.setView(this.currentView);

    // Flush any data that arrived before init completed
    this.flushMarkers();
  }

  // ─── Marker element builder ────────────────────────────────────────────────

  private buildMarkerElement(d: GlobeMarker): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'pointer-events:auto;cursor:pointer;user-select:none;';

    if (d._kind === 'conflict') {
      const size = Math.min(12, 6 + (d.fatalities ?? 0) * 0.4);
      el.innerHTML = `
        <div style="position:relative;width:${size}px;height:${size}px;">
          <div style="
            position:absolute;inset:0;border-radius:50%;
            background:rgba(255,50,50,0.85);
            border:1.5px solid rgba(255,120,120,0.9);
            box-shadow:0 0 6px 2px rgba(255,50,50,0.5);
          "></div>
          <div style="
            position:absolute;inset:-4px;border-radius:50%;
            background:rgba(255,50,50,0.2);
            animation:globe-pulse 2s ease-out infinite;
          "></div>
        </div>`;
      el.title = `${d.location}`;
    } else if (d._kind === 'hotspot') {
      const colors: Record<number, string> = { 5: '#ff2020', 4: '#ff6600', 3: '#ffaa00', 2: '#ffdd00', 1: '#88ff44' };
      const c = colors[d.escalationScore] ?? '#ffaa00';
      el.innerHTML = `
        <div style="
          width:10px;height:10px;
          background:${c};
          border:1.5px solid rgba(255,255,255,0.6);
          clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);
          box-shadow:0 0 8px 2px ${c}88;
        "></div>`;
      el.title = d.name;
    } else if (d._kind === 'flight') {
      const heading = d.heading ?? 0;
      const typeColors: Record<string, string> = {
        fighter: '#ff4444', bomber: '#ff8800', recon: '#44aaff',
        tanker: '#88ff44', transport: '#aaaaff', helicopter: '#ffff44',
        drone: '#ff44ff', maritime: '#44ffff',
      };
      const color = typeColors[d.type] ?? '#cccccc';
      el.innerHTML = `
        <div style="transform:rotate(${heading}deg);font-size:11px;color:${color};text-shadow:0 0 4px ${color}88;line-height:1;">
          ✈
        </div>`;
      el.title = `${d.callsign} (${d.type})`;
    } else if (d._kind === 'vessel') {
      const typeColors: Record<string, string> = {
        carrier: '#ff4444', destroyer: '#ff8800', submarine: '#8844ff',
        frigate: '#44aaff', amphibious: '#88ff44', support: '#aaaaaa',
      };
      const c = typeColors[d.type] ?? '#44aaff';
      el.innerHTML = `<div style="font-size:10px;color:${c};text-shadow:0 0 4px ${c}88;">⛴</div>`;
      el.title = `${d.name} (${d.type})`;
    } else if (d._kind === 'weather') {
      const severityColors: Record<string, string> = {
        Extreme: '#ff0044', Severe: '#ff6600', Moderate: '#ffaa00', Minor: '#88aaff',
      };
      const c = severityColors[d.severity] ?? '#88aaff';
      el.innerHTML = `<div style="font-size:9px;color:${c};text-shadow:0 0 4px ${c}88;font-weight:bold;">⚡</div>`;
      el.title = d.headline;
    } else if (d._kind === 'natural') {
      const typeIcons: Record<string, string> = {
        earthquakes: '〽', volcanoes: '🌋', severeStorms: '🌀',
        floods: '💧', wildfires: '🔥', drought: '☀',
      };
      const icon = typeIcons[d.category] ?? '⚠';
      el.innerHTML = `<div style="font-size:11px;">${icon}</div>`;
      el.title = d.title;
    } else if (d._kind === 'iran') {
      const sc = d.severity === 'high' ? '#ff3030' : d.severity === 'medium' ? '#ff8800' : '#ffcc00';
      el.innerHTML = `
        <div style="position:relative;width:9px;height:9px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${sc};border:1.5px solid rgba(255,255,255,0.5);box-shadow:0 0 5px 2px ${sc}88;"></div>
          <div style="position:absolute;inset:-4px;border-radius:50%;background:${sc}33;animation:globe-pulse 2s ease-out infinite;"></div>
        </div>`;
      el.title = d.title;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      el.innerHTML = `<div style="font-size:12px;color:${sc};text-shadow:0 0 4px ${sc}88;">📡</div>`;
      el.title = `${d.country}: ${d.title}`;
    } else if (d._kind === 'cyber') {
      const sc = d.severity === 'critical' ? '#ff0044' : d.severity === 'high' ? '#ff4400' : d.severity === 'medium' ? '#ffaa00' : '#44aaff';
      el.innerHTML = `<div style="font-size:10px;color:${sc};text-shadow:0 0 4px ${sc}88;font-weight:bold;">🛡</div>`;
      el.title = `${d.type}: ${d.indicator}`;
    } else if (d._kind === 'fire') {
      const intensity = d.brightness > 400 ? '#ff2020' : d.brightness > 330 ? '#ff6600' : '#ffaa00';
      el.innerHTML = `<div style="font-size:10px;color:${intensity};text-shadow:0 0 4px ${intensity}88;">🔥</div>`;
      el.title = `Fire — ${d.region}`;
    } else if (d._kind === 'protest') {
      const typeColors: Record<string, string> = {
        riot: '#ff3030', protest: '#ffaa00', strike: '#44aaff',
        demonstration: '#88ff44', civil_unrest: '#ff6600',
      };
      const c = typeColors[d.eventType] ?? '#ffaa00';
      el.innerHTML = `<div style="font-size:11px;color:${c};text-shadow:0 0 4px ${c}88;">📢</div>`;
      el.title = d.title;
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleMarkerClick(d, el);
    });

    return el;
  }

  private handleMarkerClick(d: GlobeMarker, anchor: HTMLElement): void {
    if (d._kind === 'hotspot' && this.onHotspotClickCb) {
      this.onHotspotClickCb({
        id: d.id,
        name: d.name,
        lat: d._lat,
        lon: d._lng,
        keywords: [],
        escalationScore: d.escalationScore as Hotspot['escalationScore'],
      });
    }
    this.showMarkerTooltip(d, anchor);
  }

  private showMarkerTooltip(d: GlobeMarker, anchor: HTMLElement): void {
    this.hideTooltip();
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      'background:rgba(10,12,16,0.95)',
      'border:1px solid rgba(60,120,60,0.6)',
      'padding:8px 12px',
      'border-radius:3px',
      'font-size:11px',
      'font-family:monospace',
      'color:#d4d4d4',
      'max-width:240px',
      'z-index:1000',
      'pointer-events:none',
      'line-height:1.5',
    ].join(';');

    let html = '';
    if (d._kind === 'conflict') {
      html = `<span style="color:#ff5050;font-weight:bold;">⚔ ${d.location}</span>` +
             (d.fatalities ? `<br><span style="opacity:.7;">Casualties: ${d.fatalities}</span>` : '');
    } else if (d._kind === 'hotspot') {
      const sc = ['', '#88ff44', '#ffdd00', '#ffaa00', '#ff6600', '#ff2020'][d.escalationScore] ?? '#ffaa00';
      html = `<span style="color:${sc};font-weight:bold;">🎯 ${d.name}</span>` +
             `<br><span style="opacity:.7;">Escalation: ${d.escalationScore}/5</span>`;
    } else if (d._kind === 'flight') {
      html = `<span style="font-weight:bold;">✈ ${d.callsign}</span><br><span style="opacity:.7;">${d.type}</span>`;
    } else if (d._kind === 'vessel') {
      html = `<span style="font-weight:bold;">⛴ ${d.name}</span><br><span style="opacity:.7;">${d.type}</span>`;
    } else if (d._kind === 'weather') {
      const wc = d.severity === 'Extreme' ? '#ff0044' : d.severity === 'Severe' ? '#ff6600' : '#88aaff';
      html = `<span style="color:${wc};font-weight:bold;">⚡ ${d.severity}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${d.headline.slice(0, 90)}</span>`;
    } else if (d._kind === 'natural') {
      html = `<span style="font-weight:bold;">${d.title.slice(0, 60)}</span>` +
             `<br><span style="opacity:.7;">${d.category}</span>`;
    } else if (d._kind === 'iran') {
      const sc = d.severity === 'high' ? '#ff3030' : d.severity === 'medium' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${sc};font-weight:bold;">🎯 ${d.title.slice(0, 60)}</span>` +
             `<br><span style="opacity:.7;">${d.category}${d.location ? ' · ' + d.location : ''}</span>`;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${sc};font-weight:bold;">📡 ${d.severity.toUpperCase()} Outage</span>` +
             `<br><span style="opacity:.7;">${d.country}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${d.title.slice(0, 70)}</span>`;
    } else if (d._kind === 'cyber') {
      const sc = d.severity === 'critical' ? '#ff0044' : d.severity === 'high' ? '#ff4400' : '#ffaa00';
      html = `<span style="color:${sc};font-weight:bold;">🛡 ${d.severity.toUpperCase()}</span>` +
             `<br><span style="opacity:.7;">${d.type}</span>` +
             `<br><span style="opacity:.5;font-size:10px;">${d.indicator.slice(0, 40)}</span>`;
    } else if (d._kind === 'fire') {
      html = `<span style="color:#ff6600;font-weight:bold;">🔥 Wildfire</span>` +
             `<br><span style="opacity:.7;">${d.region}</span>` +
             `<br><span style="opacity:.5;">Brightness: ${d.brightness.toFixed(0)} K</span>`;
    } else if (d._kind === 'protest') {
      const typeColors: Record<string, string> = { riot: '#ff3030', strike: '#44aaff', protest: '#ffaa00' };
      const c = typeColors[d.eventType] ?? '#ffaa00';
      html = `<span style="color:${c};font-weight:bold;">📢 ${d.eventType}</span>` +
             `<br><span style="opacity:.7;">${d.country}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${d.title.slice(0, 70)}</span>`;
    }
    el.innerHTML = html;

    // Position relative to container
    const ar = anchor.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    let left = ar.left - cr.left + (anchor.offsetWidth ?? 14) + 6;
    let top  = ar.top  - cr.top  - 8;
    left = Math.max(4, Math.min(left, cr.width  - 248));
    top  = Math.max(4, Math.min(top,  cr.height - 80));
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';

    this.container.appendChild(el);
    this.tooltipEl = el;
    setTimeout(() => this.hideTooltip(), 3500);
  }

  private hideTooltip(): void {
    this.tooltipEl?.remove();
    this.tooltipEl = null;
  }

  // ─── Overlay UI: zoom controls & layer panel ─────────────────────────────

  private createControls(): void {
    const el = document.createElement('div');
    el.className = 'map-controls deckgl-controls';
    el.innerHTML = `
      <div class="zoom-controls">
        <button class="map-btn zoom-in"    title="Zoom in">+</button>
        <button class="map-btn zoom-out"   title="Zoom out">-</button>
        <button class="map-btn zoom-reset" title="Reset view">&#8962;</button>
      </div>`;
    this.container.appendChild(el);
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if      (target.classList.contains('zoom-in'))    this.zoomInGlobe();
      else if (target.classList.contains('zoom-out'))   this.zoomOutGlobe();
      else if (target.classList.contains('zoom-reset')) this.setView(this.currentView);
    });
  }

  private zoomInGlobe(): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    const alt = Math.max(0.05, (pov.altitude ?? 1.8) * 0.6);
    this.globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: alt }, 500);
  }

  private zoomOutGlobe(): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    const alt = Math.min(4.0, (pov.altitude ?? 1.8) * 1.6);
    this.globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: alt }, 500);
  }

  private createLayerToggles(): void {
    const layers: Array<{ key: string; label: string; icon: string }> = [
      // Conflict & Security
      { key: 'iranAttacks',  label: 'Iran Threat Activity',  icon: '&#127919;' },
      { key: 'hotspots',     label: 'Intel Hotspots',        icon: '&#127919;' },
      { key: 'conflicts',    label: 'Conflict Zones',         icon: '&#9876;'   },
      { key: 'bases',        label: 'Military Bases',         icon: '&#127963;' },
      { key: 'nuclear',      label: 'Nuclear Sites',          icon: '&#9762;'   },
      { key: 'irradiators',  label: 'Gamma Irradiators',      icon: '&#9888;'   },
      { key: 'spaceports',   label: 'Spaceports',             icon: '&#128640;' },
      { key: 'military',     label: 'Military Activity',      icon: '&#9992;'   },
      { key: 'ais',          label: 'Ship Traffic',           icon: '&#128674;' },
      { key: 'flights',      label: 'Flight Delays',          icon: '&#9992;'   },
      { key: 'protests',     label: 'Protests & Unrest',      icon: '&#128226;' },
      { key: 'ucdpEvents',   label: 'UCDP Events',            icon: '&#9876;'   },
      { key: 'displacement', label: 'Displacement Flows',     icon: '&#128101;' },
      // Infrastructure
      { key: 'cables',       label: 'Undersea Cables',        icon: '&#128268;' },
      { key: 'pipelines',    label: 'Pipelines',              icon: '&#128738;' },
      { key: 'datacenters',  label: 'Data Centers',           icon: '&#128421;' },
      { key: 'tradeRoutes',  label: 'Trade Routes',           icon: '&#9875;'   },
      { key: 'waterways',    label: 'Strategic Waterways',    icon: '&#9875;'   },
      { key: 'economic',     label: 'Economic Centers',       icon: '&#128176;' },
      { key: 'minerals',     label: 'Critical Minerals',      icon: '&#128142;' },
      // Hazards & Environment
      { key: 'weather',      label: 'Weather Alerts',         icon: '&#9928;'   },
      { key: 'natural',      label: 'Natural Events',         icon: '&#127755;' },
      { key: 'fires',        label: 'Wildfires',              icon: '&#128293;' },
      { key: 'climate',      label: 'Climate Anomalies',      icon: '&#127787;' },
      { key: 'outages',      label: 'Internet Outages',       icon: '&#128225;' },
      { key: 'cyberThreats', label: 'Cyber Threats',          icon: '&#128737;' },
      { key: 'gpsJamming',   label: 'GPS Jamming',            icon: '&#128225;' },
      { key: 'dayNight',     label: 'Day / Night',            icon: '&#127763;' },
    ];

    const el = document.createElement('div');
    el.className = 'layer-toggles deckgl-layer-toggles';
    // Override deckgl-layer-toggles CSS which places at bottom; globe needs top-left
    el.style.bottom = 'auto';
    el.style.top = '10px';
    el.innerHTML = `
      <div class="toggle-header">
        <span>LAYERS</span>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <div class="toggle-list" style="max-height:32vh;overflow-y:auto;scrollbar-width:thin;">
        ${layers.map(({ key, label, icon }) => `
          <label class="layer-toggle" data-layer="${key}">
            <input type="checkbox" ${(this.layers as any)[key] ? 'checked' : ''}>
            <span class="toggle-icon">${icon}</span>
            <span class="toggle-label">${label}</span>
          </label>`).join('')}
      </div>`;
    this.container.appendChild(el);

    el.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer');
        if (layer) {
          const checked = (input as HTMLInputElement).checked;
          (this.layers as any)[layer] = checked;
          this.flushMarkers();
          this.onLayerChangeCb?.(layer as keyof MapLayers, checked, 'user');
        }
      });
    });

    const collapseBtn = el.querySelector('.toggle-collapse');
    const list = el.querySelector('.toggle-list') as HTMLElement | null;
    let collapsed = false;
    collapseBtn?.addEventListener('click', () => {
      collapsed = !collapsed;
      if (list) list.style.display = collapsed ? 'none' : '';
      if (collapseBtn) (collapseBtn as HTMLElement).innerHTML = collapsed ? '&#9654;' : '&#9660;';
    });

    // Intercept wheel on layer panel — scroll list, don't zoom globe
    el.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (list) list.scrollTop += e.deltaY;
    }, { passive: false });

    this.layerTogglesEl = el;
  }

  // ─── Flush all current data to globe ──────────────────────────────────────

  private flushMarkers(): void {
    if (!this.globe || !this.initialized) return;

    const markers: GlobeMarker[] = [];
    if (this.layers.conflicts) markers.push(...this.conflicts);
    if (this.layers.hotspots) markers.push(...this.hotspots);
    if (this.layers.military) {
      markers.push(...this.flights);
      markers.push(...this.vessels);
    }
    if (this.layers.weather) markers.push(...this.weatherMarkers);
    if (this.layers.natural) markers.push(...this.naturalMarkers);
    if ((this.layers as any).iranAttacks) markers.push(...this.iranMarkers);
    if (this.layers.outages) markers.push(...this.outageMarkers);
    if (this.layers.cyberThreats) markers.push(...this.cyberMarkers);
    if ((this.layers as any).fires) markers.push(...this.fireMarkers);
    if (this.layers.protests) markers.push(...this.protestMarkers);

    this.globe.htmlElementsData(markers);
  }

  // ─── Public data setters ──────────────────────────────────────────────────

  public setHotspots(hotspots: Hotspot[]): void {
    this.hotspots = hotspots.map(h => ({
      _kind: 'hotspot' as const,
      _lat: h.lat,
      _lng: h.lon,
      id: h.id,
      name: h.name,
      escalationScore: h.escalationScore ?? 1,
    }));
    this.flushMarkers();
  }

  private setConflictZones(): void {
    this.conflicts = CONFLICT_ZONES.map(zone => ({
      _kind: 'conflict' as const,
      _lat: zone.center[1],
      _lng: zone.center[0],
      id: zone.id,
      fatalities: 0,
      eventType: zone.intensity ?? 'high',
      location: zone.name,
    }));
    this.flushMarkers();
  }

  public setMilitaryFlights(flights: MilitaryFlight[]): void {
    this.flights = flights.map(f => ({
      _kind: 'flight' as const,
      _lat: f.lat,
      _lng: f.lon,
      id: f.id,
      callsign: f.callsign ?? '',
      type: (f as any).aircraftType ?? (f as any).type ?? 'fighter',
      heading: (f as any).heading ?? 0,
    }));
    this.flushMarkers();
  }

  public setMilitaryVessels(vessels: MilitaryVessel[]): void {
    this.vessels = vessels.map(v => ({
      _kind: 'vessel' as const,
      _lat: v.lat,
      _lng: v.lon,
      id: v.id,
      name: (v as any).name ?? 'vessel',
      type: (v as any).vesselType ?? 'destroyer',
    }));
    this.flushMarkers();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherMarkers = (alerts ?? [])
      .filter(a => (a as any).lat != null && (a as any).lon != null)
      .map(a => ({
        _kind: 'weather' as const,
        _lat: (a as any).lat,
        _lng: (a as any).lon,
        id: (a as any).id ?? Math.random().toString(36),
        severity: (a as any).severity ?? 'Minor',
        headline: (a as any).headline ?? (a as any).event ?? '',
      }));
    this.flushMarkers();
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalMarkers = (events ?? []).map(e => ({
      _kind: 'natural' as const,
      _lat: e.lat,
      _lng: e.lon,
      id: e.id,
      category: e.category ?? '',
      title: e.title ?? '',
    }));
    this.flushMarkers();
  }

  // ─── Layer control ────────────────────────────────────────────────────────

  public setLayers(layers: MapLayers): void {
    this.layers = { ...layers };
    this.flushMarkers();
  }

  public enableLayer(layer: keyof MapLayers): void {
    (this.layers as any)[layer] = true;
    this.flushMarkers();
  }

  // ─── Camera / navigation ──────────────────────────────────────────────────

  private static readonly VIEW_POVS: Record<MapView, { lat: number; lng: number; altitude: number }> = {
    global:   { lat: 20,  lng:  0,   altitude: 1.8 },
    america:  { lat: 20,  lng: -90,  altitude: 1.5 },
    mena:     { lat: 25,  lng:  40,  altitude: 1.2 },
    eu:       { lat: 50,  lng:  10,  altitude: 1.2 },
    asia:     { lat: 35,  lng: 105,  altitude: 1.5 },
    latam:    { lat: -15, lng: -60,  altitude: 1.5 },
    africa:   { lat:  5,  lng:  20,  altitude: 1.5 },
    oceania:  { lat: -25, lng: 140,  altitude: 1.5 },
  };

  public setView(view: MapView): void {
    this.currentView = view;
    if (!this.globe) return;
    const pov = GlobeMap.VIEW_POVS[view] ?? GlobeMap.VIEW_POVS.global;
    this.globe.pointOfView(pov, 1200);
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (!this.globe) return;
    // Map deck.gl zoom levels → globe.gl altitude
    // deck.gl: 2=world, 3=continent, 4=country, 5=region, 6+=city
    // globe.gl altitude: 1.8=full globe, 0.6=country, 0.15=city
    let altitude = 1.2;
    if (zoom !== undefined) {
      if      (zoom >= 7) altitude = 0.08;
      else if (zoom >= 6) altitude = 0.15;
      else if (zoom >= 5) altitude = 0.3;
      else if (zoom >= 4) altitude = 0.5;
      else if (zoom >= 3) altitude = 0.8;
      else                altitude = 1.5;
    }
    this.globe.pointOfView({ lat, lng: lon, altitude }, 1200);
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (!this.globe) return null;
    const pov = this.globe.pointOfView();
    return pov ? { lat: pov.lat, lon: pov.lng } : null;
  }

  // ─── Resize ────────────────────────────────────────────────────────────────

  public resize(): void {
    if (!this.globe || this.destroyed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w > 0 && h > 0) this.globe.width(w).height(h);
  }

  // ─── State API ────────────────────────────────────────────────────────────

  public getState(): MapContainerState {
    return {
      zoom: 1,
      pan: { x: 0, y: 0 },
      view: this.currentView,
      layers: this.layers,
      timeRange: this.timeRange,
    };
  }

  public setTimeRange(range: TimeRange): void {
    this.timeRange = range;
  }

  public getTimeRange(): TimeRange {
    return this.timeRange;
  }

  // ─── Callback setters ─────────────────────────────────────────────────────

  public setOnHotspotClick(cb: (h: Hotspot) => void): void {
    this.onHotspotClickCb = cb;
  }

  public setOnCountryClick(_cb: (c: CountryClickPayload) => void): void {
    // Globe country click not yet implemented — no-op
  }

  // ─── No-op stubs (keep MapContainer happy) ────────────────────────────────
  public render(): void { this.resize(); }
  public setIsResizing(isResizing: boolean): void {
    // After drag-resize or fullscreen transition completes, re-sync dimensions
    if (!isResizing) this.resize();
  }
  public setZoom(_z: number): void {}
  public setRenderPaused(_paused: boolean): void {}
  public updateHotspotActivity(_news: any[]): void {}
  public updateMilitaryForEscalation(_f: any[], _v: any[]): void {}
  public getHotspotDynamicScore(_id: string) { return undefined; }
  public getHotspotLevels() { return {} as Record<string, string>; }
  public setHotspotLevels(_l: Record<string, string>): void {}
  public initEscalationGetters(): void {}
  public highlightAssets(_assets: any): void {}
  public setOnLayerChange(cb: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChangeCb = cb;
  }
  public setOnTimeRangeChange(_cb: any): void {}
  public hideLayerToggle(layer: keyof MapLayers): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.remove();
  }
  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('loading', loading);
  }
  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('no-data', !hasData);
  }
  public flashAssets(_type: string, _ids: string[]): void {}
  public flashLocation(_lat: number, _lon: number, _ms?: number): void {}
  public triggerHotspotClick(_id: string): void {}
  public triggerConflictClick(_id: string): void {}
  public triggerBaseClick(_id: string): void {}
  public triggerPipelineClick(_id: string): void {}
  public triggerCableClick(_id: string): void {}
  public triggerDatacenterClick(_id: string): void {}
  public triggerNuclearClick(_id: string): void {}
  public triggerIrradiatorClick(_id: string): void {}
  public fitCountry(code: string): void {
    if (!this.globe) return;
    const bbox = getCountryBbox(code);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lat = (minLat + maxLat) / 2;
    const lng = (minLon + maxLon) / 2;
    const span = Math.max(maxLat - minLat, maxLon - minLon);
    // Map geographic span → altitude: large country (Russia ~170°) vs small (Luxembourg ~0.5°)
    const altitude = span > 60 ? 1.0 : span > 20 ? 0.7 : span > 8 ? 0.45 : span > 3 ? 0.25 : 0.12;
    this.globe.pointOfView({ lat, lng, altitude }, 1200);
  }
  public highlightCountry(_code: string): void {}
  public clearCountryHighlight(): void {}
  public setEarthquakes(_e: any[]): void {}
  public setOutages(outages: InternetOutage[]): void {
    this.outageMarkers = (outages ?? []).filter(o => o.lat != null && o.lon != null).map(o => ({
      _kind: 'outage' as const,
      _lat: o.lat,
      _lng: o.lon,
      id: o.id,
      title: o.title ?? '',
      severity: o.severity ?? 'partial',
      country: o.country ?? '',
    }));
    this.flushMarkers();
  }
  public setAisData(_d: any[], _z: any[]): void {}
  public setCableActivity(_a: any[], _r: any[]): void {}
  public setCableHealth(_m: any): void {}
  public setProtests(events: SocialUnrestEvent[]): void {
    this.protestMarkers = (events ?? []).filter(e => e.lat != null && e.lon != null).map(e => ({
      _kind: 'protest' as const,
      _lat: e.lat,
      _lng: e.lon,
      id: e.id,
      title: e.title ?? '',
      eventType: e.eventType ?? 'protest',
      country: e.country ?? '',
    }));
    this.flushMarkers();
  }
  public setFlightDelays(_delays: any[]): void {}
  public setNewsLocations(_data: any[]): void {}
  public setPositiveEvents(_events: any[]): void {}
  public setKindnessData(_points: any[]): void {}
  public setHappinessScores(_data: any): void {}
  public setSpeciesRecoveryZones(_zones: any[]): void {}
  public setRenewableInstallations(_installations: any[]): void {}
  public setDisplacementFlows(_flows: any[]): void {}
  public setClimateAnomalies(_anomalies: any[]): void {}
  public setGpsJamming(_hexes: any[]): void {}
  public setCyberThreats(threats: CyberThreat[]): void {
    this.cyberMarkers = (threats ?? []).filter(t => t.lat != null && t.lon != null).map(t => ({
      _kind: 'cyber' as const,
      _lat: t.lat,
      _lng: t.lon,
      id: t.id,
      indicator: t.indicator ?? '',
      severity: t.severity ?? 'low',
      type: t.type ?? 'malware_host',
    }));
    this.flushMarkers();
  }
  public setIranEvents(events: IranEvent[]): void {
    this.iranMarkers = (events ?? []).filter(e => e.latitude != null && e.longitude != null).map(e => ({
      _kind: 'iran' as const,
      _lat: e.latitude,
      _lng: e.longitude,
      id: e.id,
      title: e.title ?? '',
      category: e.category ?? '',
      severity: e.severity ?? 'medium',
      location: e.locationName ?? '',
    }));
    this.flushMarkers();
  }
  public setTechEvents(_events: any[]): void {}
  public setUcdpEvents(_events: any[]): void {}
  public setFires(fires: NaturalEvent[]): void {
    this.fireMarkers = (fires ?? []).filter(f => f.lat != null && f.lon != null).map(f => ({
      _kind: 'fire' as const,
      _lat: f.lat,
      _lng: f.lon,
      id: f.id,
      region: f.title ?? '',
      brightness: (f as any).brightness ?? 330,
    }));
    this.flushMarkers();
  }
  public onHotspotClicked(cb: (h: Hotspot) => void): void { this.onHotspotClickCb = cb; }
  public onTimeRangeChanged(_cb: (r: TimeRange) => void): void {}
  public onStateChanged(_cb: (s: MapContainerState) => void): void {}
  public setOnCountry(_cb: any): void {}
  public getHotspotLevel(_id: string) { return 'low'; }

  // ─── Destroy ──────────────────────────────────────────────────────────────

  public destroy(): void {
    this.destroyed = true;
    if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.hideTooltip();
    this.layerTogglesEl = null;
    if (this.globe) {
      try { this.globe._destructor(); } catch { /* ignore */ }
      this.globe = null;
    }
    this.container.innerHTML = '';
    this.container.classList.remove('globe-mode');
    this.container.style.cssText = '';
  }
}
