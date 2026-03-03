import type {
    ServerContext,
    TrackAircraftRequest,
    TrackAircraftResponse,
    PositionSample,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';

const CACHE_TTL_MS = 15_000; // 15 second in-memory cache

// In-memory cache (per invocation)
let cachedPositions: PositionSample[] | null = null;
let cacheTs = 0;

interface OpenSkyState {
    icao24: string; states?: unknown[][];
}

interface OpenSkyResponse {
    states?: unknown[][];
}

function parseOpenSkyStates(states: unknown[][]): PositionSample[] {
    const now = Date.now();
    return states
        .filter(s => Array.isArray(s) && s[5] != null && s[6] != null)
        .map((s): PositionSample => ({
            icao24: String(s[0] ?? ''),
            callsign: String(s[1] ?? '').trim(),
            lat: Number(s[6]),
            lon: Number(s[5]),
            altitudeM: Number(s[7] ?? 0),
            groundSpeedKts: Number(s[9] ?? 0) * 1.944,
            trackDeg: Number(s[10] ?? 0),
            verticalRate: Number(s[11] ?? 0),
            onGround: Boolean(s[8]),
            source: 'POSITION_SOURCE_OPENSKY',
            observedAt: Number(s[4] ?? (now / 1000)) * 1000,
        }));
}

function buildSimulatedPositions(icao24: string, callsign: string, swLat: number, swLon: number, neLat: number, neLon: number): PositionSample[] {
    const now = Date.now();
    const latSpan = neLat - swLat;
    const lonSpan = neLon - swLon;
    const count = latSpan > 0 && lonSpan > 0 ? Math.floor(Math.random() * 8) + 3 : 3;

    return Array.from({ length: count }, (_, i) => ({
        icao24: icao24 || `3c${(0x6543 + i).toString(16)}`,
        callsign: callsign || `SIM${100 + i}`,
        lat: swLat + Math.random() * (latSpan || 5),
        lon: swLon + Math.random() * (lonSpan || 5),
        altitudeM: 8000 + Math.random() * 3000,
        groundSpeedKts: 400 + Math.random() * 100,
        trackDeg: Math.random() * 360,
        verticalRate: (Math.random() - 0.5) * 5,
        onGround: false,
        source: 'POSITION_SOURCE_SIMULATED' as const,
        observedAt: now,
    }));
}

export async function trackAircraft(
    _ctx: ServerContext,
    req: TrackAircraftRequest,
): Promise<TrackAircraftResponse> {
    const now = Date.now();

    // Serve from in-memory cache if fresh
    if (cachedPositions && now - cacheTs < CACHE_TTL_MS) {
        let positions = cachedPositions;
        if (req.icao24) positions = positions.filter(p => p.icao24 === req.icao24);
        if (req.callsign) positions = positions.filter(p => p.callsign.includes(req.callsign.toUpperCase()));
        return { positions, source: 'opensky-cache', updatedAt: cacheTs };
    }

    const relayBase = getRelayBaseUrl();
    if (!relayBase) {
        const positions = buildSimulatedPositions(req.icao24, req.callsign, req.swLat, req.swLon, req.neLat, req.neLon);
        return { positions, source: 'simulated', updatedAt: now };
    }

    try {
        // Use bbox if bounds provided, else fetch all or single aircraft
        let osUrl: string;
        if (req.swLat && req.neLat) {
            osUrl = `${relayBase}/opensky/states/all?lamin=${req.swLat}&lomin=${req.swLon}&lamax=${req.neLat}&lomax=${req.neLon}`;
        } else if (req.icao24) {
            osUrl = `${relayBase}/opensky/states/all?icao24=${req.icao24}`;
        } else {
            osUrl = `${relayBase}/opensky/states/all`;
        }

        const resp = await fetch(osUrl, {
            headers: getRelayHeaders({}),
            signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as OpenSkyResponse;
        const positions = parseOpenSkyStates(data.states ?? []);

        cachedPositions = positions;
        cacheTs = now;

        let filtered = positions;
        if (req.icao24) filtered = filtered.filter(p => p.icao24 === req.icao24);
        if (req.callsign) filtered = filtered.filter(p => p.callsign.includes(req.callsign.toUpperCase()));

        return { positions: filtered, source: 'opensky', updatedAt: now };
    } catch (err) {
        console.warn(`[Aviation] TrackAircraft failed: ${err instanceof Error ? err.message : err}`);
        const positions = buildSimulatedPositions(req.icao24, req.callsign, req.swLat, req.swLon, req.neLat, req.neLon);
        return { positions, source: 'simulated', updatedAt: now };
    }
}
