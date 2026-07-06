// Thin Spotify Web API client plus response-trimming helpers.
// Ported from the original Rust `spotify.rs`.

const API_BASE = "https://api.spotify.com/v1";

type Json = any;

/**
 * Minimal Spotify Web API wrapper. It defers to a caller-supplied token getter
 * so token refresh/persistence can live on the McpAgent (which owns state).
 */
export class SpotifyClient {
	constructor(private getToken: () => Promise<string>) {}

	private async request(method: string, path: string, body?: Json): Promise<Json> {
		const token = await this.getToken();
		const hasBody = body !== undefined;
		const resp = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(hasBody ? { "Content-Type": "application/json" } : {}),
			},
			body: hasBody ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		if (!resp.ok) {
			throw new Error(`Spotify API error ${resp.status}: ${text}`);
		}
		if (text.trim().length === 0) {
			return { status: "ok" };
		}
		return JSON.parse(text);
	}

	get(path: string): Promise<Json> {
		return this.request("GET", path);
	}

	post(path: string, body: Json = {}): Promise<Json> {
		return this.request("POST", path, body);
	}

	put(path: string, body?: Json): Promise<Json> {
		return this.request("PUT", path, body);
	}

	delete(path: string, body?: Json): Promise<Json> {
		return this.request("DELETE", path, body);
	}
}

/** Normalizes a bare ID or URI into a full Spotify URI of the given kind. */
export function toUri(kind: string, idOrUri: string): string {
	return idOrUri.includes(":") ? idOrUri : `spotify:${kind}:${idOrUri}`;
}

/** Strips a `spotify:kind:` prefix if present, returning the bare ID. */
export function toId(idOrUri: string): string {
	const parts = idOrUri.split(":");
	return parts[parts.length - 1] || idOrUri;
}

// --- Response trimming: keep tool output compact for the model ---

export function trimTrack(t: Json): Json {
	const track = t && typeof t.track === "object" && t.track !== null ? t.track : t;
	return {
		name: track?.name ?? null,
		id: track?.id ?? null,
		uri: track?.uri ?? null,
		artists: Array.isArray(track?.artists)
			? track.artists.map((a: Json) => a?.name ?? null)
			: null,
		album: track?.album?.name ?? null,
		duration_ms: track?.duration_ms ?? null,
	};
}

export function trimPlaylist(p: Json): Json {
	return {
		name: p?.name ?? null,
		id: p?.id ?? null,
		uri: p?.uri ?? null,
		description: p?.description ?? null,
		public: p?.public ?? null,
		collaborative: p?.collaborative ?? null,
		owner: p?.owner?.display_name ?? null,
		tracks_total: p?.tracks?.total ?? null,
		snapshot_id: p?.snapshot_id ?? null,
	};
}

export function trimPaged(page: Json, f: (v: Json) => Json): Json {
	return {
		total: page?.total ?? null,
		limit: page?.limit ?? null,
		offset: page?.offset ?? null,
		items: Array.isArray(page?.items) ? page.items.map(f) : null,
	};
}

/** Clamp helper matching the original `.clamp(1, 50)` behavior. */
export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}
