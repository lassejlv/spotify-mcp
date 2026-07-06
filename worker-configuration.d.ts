// Bindings available to the Worker. Regenerate the runtime portion any time with
// `npx wrangler types`; the fields below are the ones this project relies on.
interface Env {
  /** KV namespace backing the OAuth provider (grants, tokens, clients, state). */
  OAUTH_KV: KVNamespace;
  /** Durable Object namespace for the SpotifyMCP agent. */
  MCP_OBJECT: DurableObjectNamespace;
  /** Spotify app Client ID (set via `wrangler secret put`). */
  SPOTIFY_CLIENT_ID: string;
  /** Spotify app Client Secret (set via `wrangler secret put`). */
  SPOTIFY_CLIENT_SECRET: string;
  /** Random secret used to sign the "approved clients" cookie. */
  COOKIE_ENCRYPTION_KEY: string;
  /**
   * Optional comma-separated allowlist of Spotify account emails. If unset or
   * empty, any Spotify account may authorize. Set via `wrangler secret put`.
   */
  ALLOWED_EMAILS?: string;
}
