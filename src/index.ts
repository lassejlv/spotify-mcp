import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { SpotifyHandler } from "./spotify-handler";
import {
	SpotifyClient,
	clamp,
	toId,
	toUri,
	trimPaged,
	trimPlaylist,
	trimTrack,
} from "./spotify";
import { isEmailAllowed, refreshSpotifyToken, type Props } from "./utils";

/** Working token state, persisted in the Durable Object. */
type State = {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
};

type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

const okText = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const okJson = (v: unknown): ToolResult => okText(JSON.stringify(v, null, 2));
const errText = (e: unknown): ToolResult => ({
	content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
	isError: true,
});

/** Wraps a tool handler so thrown errors become MCP error results. */
function guard<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
	return async (args: A) => {
		try {
			return await fn(args);
		} catch (e) {
			return errText(e);
		}
	};
}

export class SpotifyMCP extends McpAgent<Env, State, Props> {
	server = new McpServer({
		name: "spotify-mcp",
		version: "0.2.0",
	});

	initialState: State = { accessToken: "", refreshToken: "", expiresAt: 0 };

	private client!: SpotifyClient;

	/** Returns a valid access token, refreshing (and persisting) it if expired. */
	private async accessToken(): Promise<string> {
		if (Date.now() + 60_000 >= this.state.expiresAt) {
			const t = await refreshSpotifyToken({
				clientId: this.env.SPOTIFY_CLIENT_ID,
				clientSecret: this.env.SPOTIFY_CLIENT_SECRET,
				refreshToken: this.state.refreshToken,
			});
			this.setState({
				accessToken: t.accessToken,
				refreshToken: t.refreshToken ?? this.state.refreshToken,
				expiresAt: t.expiresAt,
			});
		}
		return this.state.accessToken;
	}

	async init() {
		// Backup access gate (primary check is at the OAuth callback). If this
		// grant's email isn't allowed, register no tools.
		if (!isEmailAllowed(this.props?.email, this.env.ALLOWED_EMAILS)) {
			return;
		}

		// Seed the persisted token state from the OAuth props on first run.
		if (!this.state.accessToken && this.props?.accessToken) {
			this.setState({
				accessToken: this.props.accessToken,
				refreshToken: this.props.refreshToken,
				expiresAt: this.props.expiresAt,
			});
		}

		this.client = new SpotifyClient(() => this.accessToken());
		const sp = () => this.client;

		this.server.registerTool(
			"get_me",
			{ description: "Get the current user's Spotify profile", inputSchema: {} },
			guard(async () => {
				const me = await sp().get("/me");
				return okJson({
					display_name: me.display_name,
					id: me.id,
					email: me.email,
					country: me.country,
					product: me.product,
					followers: me.followers?.total,
				});
			}),
		);

		this.server.registerTool(
			"search",
			{
				description:
					"Search Spotify for tracks, albums, artists or playlists. Returns compact results with names, IDs and URIs.",
				inputSchema: {
					query: z
						.string()
						.describe(
							"Search query. Supports Spotify field filters like artist:, album:, track:, year:",
						),
					types: z
						.string()
						.optional()
						.describe(
							"Comma-separated item types to search: track, album, artist, playlist (default: track)",
						),
					limit: z.number().int().optional().describe("Max results per type, 1-50 (default 10)"),
				},
			},
			guard(async ({ query, types, limit }) => {
				const t = types ?? "track";
				const lim = clamp(limit ?? 10, 1, 50);
				const path = `/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(t)}&limit=${lim}`;
				const res = await sp().get(path);
				const out: Record<string, unknown> = {};
				if (res.tracks) out.tracks = trimPaged(res.tracks, trimTrack);
				if (res.playlists) {
					out.playlists = trimPaged(res.playlists, (p) => (p == null ? null : trimPlaylist(p)));
				}
				for (const kind of ["albums", "artists"] as const) {
					if (res[kind]) {
						out[kind] = trimPaged(res[kind], (x) => ({
							name: x?.name ?? null,
							id: x?.id ?? null,
							uri: x?.uri ?? null,
							artists: Array.isArray(x?.artists)
								? x.artists.map((a: any) => a?.name ?? null)
								: null,
						}));
					}
				}
				return okJson(out);
			}),
		);

		this.server.registerTool(
			"list_playlists",
			{
				description: "List the current user's playlists",
				inputSchema: {
					limit: z.number().int().optional().describe("Max items to return, 1-50 (default 20)"),
					offset: z
						.number()
						.int()
						.optional()
						.describe("Index of the first item to return (default 0)"),
				},
			},
			guard(async ({ limit, offset }) => {
				const lim = clamp(limit ?? 20, 1, 50);
				const off = offset ?? 0;
				const res = await sp().get(`/me/playlists?limit=${lim}&offset=${off}`);
				return okJson(trimPaged(res, trimPlaylist));
			}),
		);

		this.server.registerTool(
			"get_playlist_tracks",
			{
				description:
					"Get a playlist's details and its tracks (with their zero-based positions, needed for reordering/removal)",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or spotify:playlist: URI"),
					limit: z.number().int().optional().describe("Max items to return, 1-50 (default 50)"),
					offset: z
						.number()
						.int()
						.optional()
						.describe("Index of the first track to return (default 0)"),
				},
			},
			guard(async ({ playlist_id, limit, offset }) => {
				const id = toId(playlist_id);
				const lim = clamp(limit ?? 50, 1, 50);
				const off = offset ?? 0;
				const details = await sp().get(
					`/playlists/${id}?fields=name,id,uri,description,public,collaborative,owner(display_name),tracks(total),snapshot_id`,
				);
				const tracks = await sp().get(`/playlists/${id}/tracks?limit=${lim}&offset=${off}`);
				const page = trimPaged(tracks, trimTrack);
				if (Array.isArray(page.items)) {
					page.items.forEach((item: any, i: number) => {
						item.position = off + i;
					});
				}
				return okJson({ playlist: trimPlaylist(details), tracks: page });
			}),
		);

		this.server.registerTool(
			"create_playlist",
			{
				description: "Create a new playlist for the current user",
				inputSchema: {
					name: z.string().describe("Name of the new playlist"),
					description: z.string().optional().describe("Playlist description"),
					public: z.boolean().optional().describe("Whether the playlist is public (default false)"),
					collaborative: z
						.boolean()
						.optional()
						.describe(
							"Whether the playlist is collaborative (default false; requires public=false)",
						),
				},
			},
			guard(async ({ name, description, public: isPublic, collaborative }) => {
				const me = await sp().get("/me");
				const userId = me.id ?? "";
				const res = await sp().post(`/users/${userId}/playlists`, {
					name,
					description: description ?? "",
					public: isPublic ?? false,
					collaborative: collaborative ?? false,
				});
				return okJson(trimPlaylist(res));
			}),
		);

		this.server.registerTool(
			"update_playlist_details",
			{
				description: "Update a playlist's name, description or public state",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or URI"),
					name: z.string().optional().describe("New name"),
					description: z.string().optional().describe("New description"),
					public: z.boolean().optional().describe("New public state"),
				},
			},
			guard(async ({ playlist_id, name, description, public: isPublic }) => {
				const id = toId(playlist_id);
				const body: Record<string, unknown> = {};
				if (name !== undefined) body.name = name;
				if (description !== undefined) body.description = description;
				if (isPublic !== undefined) body.public = isPublic;
				if (Object.keys(body).length === 0) {
					return okText("Nothing to update - provide name, description or public.");
				}
				await sp().put(`/playlists/${id}`, body);
				return okText("Playlist updated.");
			}),
		);

		this.server.registerTool(
			"add_tracks_to_playlist",
			{
				description: "Add tracks to a playlist, optionally at a specific position",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or URI"),
					uris: z
						.array(z.string())
						.describe("Track IDs or spotify:track: URIs to add (max 100)"),
					position: z
						.number()
						.int()
						.optional()
						.describe("Zero-based position to insert the tracks at (default: append to end)"),
				},
			},
			guard(async ({ playlist_id, uris, position }) => {
				const id = toId(playlist_id);
				const fullUris = uris.map((u) => toUri("track", u));
				const body: Record<string, unknown> = { uris: fullUris };
				if (position !== undefined) body.position = position;
				const res = await sp().post(`/playlists/${id}/tracks`, body);
				return okJson({ added: fullUris.length, snapshot_id: res.snapshot_id });
			}),
		);

		this.server.registerTool(
			"remove_tracks_from_playlist",
			{
				description: "Remove all occurrences of the given tracks from a playlist",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or URI"),
					uris: z
						.array(z.string())
						.describe("Track IDs or spotify:track: URIs to remove (all occurrences, max 100)"),
				},
			},
			guard(async ({ playlist_id, uris }) => {
				const id = toId(playlist_id);
				const tracks = uris.map((u) => ({ uri: toUri("track", u) }));
				const res = await sp().delete(`/playlists/${id}/tracks`, { tracks });
				return okJson({ removed: tracks.length, snapshot_id: res.snapshot_id });
			}),
		);

		this.server.registerTool(
			"reorder_playlist_tracks",
			{
				description:
					"Move a track (or a consecutive range of tracks) to a different position in a playlist. Use get_playlist_tracks first to see current positions.",
				inputSchema: {
					playlist_id: z.string().describe("Playlist ID or URI"),
					range_start: z.number().int().describe("Zero-based position of the first track to move"),
					insert_before: z
						.number()
						.int()
						.describe(
							"Zero-based position where the moved tracks should be inserted. E.g. to move a track to the start use 0; to move it to the end use the playlist length.",
						),
					range_length: z
						.number()
						.int()
						.optional()
						.describe("Number of consecutive tracks to move, starting at range_start (default 1)"),
				},
			},
			guard(async ({ playlist_id, range_start, insert_before, range_length }) => {
				const id = toId(playlist_id);
				const res = await sp().put(`/playlists/${id}/tracks`, {
					range_start,
					insert_before,
					range_length: range_length ?? 1,
				});
				return okJson({ reordered: true, snapshot_id: res.snapshot_id });
			}),
		);

		this.server.registerTool(
			"unfollow_playlist",
			{
				description:
					"Unfollow (delete from your library) a playlist. For playlists you own this effectively deletes them.",
				inputSchema: { playlist_id: z.string().describe("Playlist ID or URI") },
			},
			guard(async ({ playlist_id }) => {
				const id = toId(playlist_id);
				await sp().delete(`/playlists/${id}/followers`);
				return okText("Playlist unfollowed/deleted.");
			}),
		);

		this.server.registerTool(
			"get_saved_tracks",
			{
				description: "List the user's saved (liked) tracks",
				inputSchema: {
					limit: z.number().int().optional().describe("Max items to return, 1-50 (default 20)"),
					offset: z
						.number()
						.int()
						.optional()
						.describe("Index of the first item to return (default 0)"),
				},
			},
			guard(async ({ limit, offset }) => {
				const lim = clamp(limit ?? 20, 1, 50);
				const off = offset ?? 0;
				const res = await sp().get(`/me/tracks?limit=${lim}&offset=${off}`);
				return okJson(trimPaged(res, trimTrack));
			}),
		);

		this.server.registerTool(
			"save_tracks",
			{
				description: "Save (like) tracks to the user's library",
				inputSchema: {
					ids: z.array(z.string()).describe("Track IDs or spotify:track: URIs (max 50)"),
				},
			},
			guard(async ({ ids }) => {
				const bareIds = ids.map(toId);
				await sp().put("/me/tracks", { ids: bareIds });
				return okText(`Saved ${bareIds.length} track(s).`);
			}),
		);

		this.server.registerTool(
			"remove_saved_tracks",
			{
				description: "Remove tracks from the user's saved (liked) tracks",
				inputSchema: {
					ids: z.array(z.string()).describe("Track IDs or spotify:track: URIs (max 50)"),
				},
			},
			guard(async ({ ids }) => {
				const bareIds = ids.map(toId);
				await sp().delete("/me/tracks", { ids: bareIds });
				return okText(`Removed ${bareIds.length} track(s).`);
			}),
		);

		this.server.registerTool(
			"get_playback_state",
			{
				description:
					"Get the current playback state: playing track, device, progress, shuffle/repeat",
				inputSchema: {},
			},
			guard(async () => {
				const res = await sp().get("/me/player");
				if (res == null || res.item == null) {
					return okText("No active playback.");
				}
				return okJson({
					is_playing: res.is_playing,
					progress_ms: res.progress_ms,
					shuffle: res.shuffle_state,
					repeat: res.repeat_state,
					device: {
						name: res.device?.name,
						id: res.device?.id,
						volume_percent: res.device?.volume_percent,
					},
					track: trimTrack(res.item),
					context: res.context?.uri,
				});
			}),
		);

		this.server.registerTool(
			"control_playback",
			{
				description:
					"Control playback: play (optionally a specific context/tracks), pause, next, previous. Requires an active Spotify device and Premium.",
				inputSchema: {
					action: z.enum(["play", "pause", "next", "previous"]).describe("One of: play, pause, next, previous"),
					context_uri: z
						.string()
						.optional()
						.describe("Context URI to play (album/playlist/artist), only with action=play"),
					uris: z
						.array(z.string())
						.optional()
						.describe("Track URIs to play, only with action=play (ignored if context_uri set)"),
					device_id: z
						.string()
						.optional()
						.describe("Target device ID (default: the currently active device)"),
				},
			},
			guard(async ({ action, context_uri, uris, device_id }) => {
				const deviceQ = device_id ? `?device_id=${encodeURIComponent(device_id)}` : "";
				switch (action) {
					case "play": {
						const body: Record<string, unknown> = {};
						if (context_uri) {
							body.context_uri = context_uri;
						} else if (uris) {
							body.uris = uris.map((u) => toUri("track", u));
						}
						await sp().put(
							`/me/player/play${deviceQ}`,
							Object.keys(body).length === 0 ? undefined : body,
						);
						break;
					}
					case "pause":
						await sp().put(`/me/player/pause${deviceQ}`);
						break;
					case "next":
						await sp().post(`/me/player/next${deviceQ}`);
						break;
					case "previous":
						await sp().post(`/me/player/previous${deviceQ}`);
						break;
				}
				return okText(`Playback action '${action}' done.`);
			}),
		);

		this.server.registerTool(
			"add_to_queue",
			{
				description: "Add a track to the playback queue",
				inputSchema: {
					uri: z.string().describe("Track ID or spotify:track: URI to add to the playback queue"),
				},
			},
			guard(async ({ uri }) => {
				const fullUri = toUri("track", uri);
				await sp().post(`/me/player/queue?uri=${encodeURIComponent(fullUri)}`);
				return okText("Added to queue.");
			}),
		);
	}
}

export default new OAuthProvider({
	apiHandlers: {
		"/mcp": SpotifyMCP.serve("/mcp"),
		"/sse": SpotifyMCP.serveSSE("/sse"),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	defaultHandler: SpotifyHandler as any,
});
