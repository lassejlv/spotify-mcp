# spotify-mcp

A **remote** MCP (Model Context Protocol) server for Spotify, running on
[Cloudflare Workers](https://developers.cloudflare.com/workers/). It lets an AI
assistant search Spotify and manage your playlists, library and playback —
including moving tracks around inside playlists.

Auth is handled entirely over the web: the server is its own OAuth provider to
the MCP client, and performs the Spotify OAuth flow upstream. There is no local
binary and no `authenticate` tool — connecting the server in your MCP client
opens the Spotify consent screen in your browser.

## Architecture

- **`McpAgent`** (`SpotifyMCP`, a Durable Object) hosts the MCP server and tools,
  served over Streamable HTTP at `/mcp` (and legacy SSE at `/sse`).
- **`@cloudflare/workers-oauth-provider`** wraps the Worker. It issues tokens to
  MCP clients and stores the upstream Spotify tokens (access + refresh) encrypted
  in the grant `props`.
- **`SpotifyHandler`** (Hono app) implements `/authorize` and `/callback`, driving
  the Spotify authorization-code flow and showing the consent dialog.
- The agent persists a working access token in its Durable Object state and
  **refreshes it automatically** using the stored refresh token.

```
MCP client ──/mcp──▶ OAuthProvider ──▶ SpotifyMCP (Durable Object)
     │                    │                     │
   /authorize        /callback            Spotify Web API
     └────── Spotify consent (browser) ────────┘
```

## Tools

| Tool | What it does |
|---|---|
| `get_me` | Current user profile |
| `search` | Search tracks / albums / artists / playlists |
| `list_playlists` | Your playlists |
| `get_playlist_tracks` | Playlist details + tracks with their positions |
| `create_playlist` | Create a playlist |
| `update_playlist_details` | Rename / re-describe / change public state |
| `add_tracks_to_playlist` | Add tracks, optionally at a specific position |
| `remove_tracks_from_playlist` | Remove tracks |
| `reorder_playlist_tracks` | Move a track (or range of tracks) to a new position |
| `unfollow_playlist` | Unfollow / delete a playlist |
| `get_saved_tracks` / `save_tracks` / `remove_saved_tracks` | Liked-songs library |
| `get_playback_state` | What's playing, on which device |
| `control_playback` | play / pause / next / previous (Premium + active device) |
| `add_to_queue` | Queue a track |

## Deploy it yourself

Runs on the Cloudflare Workers free tier.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) and the Wrangler CLI logged in (`npx wrangler login`).
- A [Spotify Developer](https://developer.spotify.com/dashboard) account.
- Node.js 18+.

### 0. Get the code

```sh
git clone https://github.com/lassejlv/spotify-mcp.git
cd spotify-mcp
npm install --ignore-scripts   # --ignore-scripts avoids an unused native build (sharp)
```

### 1. Create a Spotify app

At <https://developer.spotify.com/dashboard>, create an app and note the
**Client ID** and **Client Secret**. Under **Redirect URIs**, add your Worker's
callback URL:

```
https://spotify-mcp.<your-subdomain>.workers.dev/callback
```

(The workers.dev subdomain is shown after the first `wrangler deploy`. Add the
URI, then deploy again if needed. A custom domain's `/callback` works too.)

### 2. Create the KV namespace

The OAuth provider stores grants, tokens and clients in KV.

```sh
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`, replacing the existing `OAUTH_KV`
`id` value (the checked-in one belongs to the original author's account and won't
work for you).

### 3. Set secrets

```sh
npx wrangler secret put SPOTIFY_CLIENT_ID       # your Spotify Client ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET   # your Spotify Client Secret
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any random string, e.g. `openssl rand -hex 32`
```

Optional — restrict who can use the server:

```sh
# Comma-separated allowlist of Spotify account emails. Only these accounts can
# authorize; everyone else is rejected at the callback (no token issued).
# Leave unset to allow any Spotify account.
npx wrangler secret put ALLOWED_EMAILS          # e.g. me@example.com,friend@example.com
```

### 4. Deploy

```sh
npx wrangler deploy
```

Your server is now live at `https://spotify-mcp.<your-subdomain>.workers.dev/mcp`.

## Connect an MCP client

Point any remote-MCP-capable client at the `/mcp` URL. Clients that only speak
stdio can bridge via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["mcp-remote", "https://spotify-mcp.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

On first connect, your browser opens: approve the MCP client, then log in and
grant Spotify access. Tokens are refreshed automatically thereafter.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in the three values
npx wrangler dev
```

`wrangler dev` simulates KV locally. Use `http://localhost:8788/callback` as an
additional Spotify redirect URI for local testing.

## Notes

- Tracks and playlists can be referenced by bare ID or full `spotify:` URI in any tool.
- `reorder_playlist_tracks` uses zero-based positions; call `get_playlist_tracks` first to see current positions.
- Playback control endpoints require Spotify Premium and an active device.
- Requested scopes: playlist read/modify (public + private), library read/modify,
  playback read/modify, `user-read-private`, and `user-read-email` (used for the
  `ALLOWED_EMAILS` access gate).
- Access control: set the `ALLOWED_EMAILS` secret to a comma-separated list to
  restrict the server to specific Spotify accounts; leave it unset to allow anyone.
