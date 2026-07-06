import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	exchangeCodeForToken,
	getUpstreamAuthorizeUrl,
	isEmailAllowed,
	SPOTIFY_SCOPES,
	type Props,
} from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

const SERVER_INFO = {
	name: "Spotify MCP Server",
	description:
		"A remote MCP server that lets an AI assistant search Spotify and manage your playlists, library, and playback.",
	logo: "https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Primary_Logo_RGB_Green.png",
};

/** Redirects the browser to Spotify's consent screen. */
async function redirectToSpotify(
	c: { env: Bindings; req: { url: string } },
	stateToken: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return new Response(null, {
		status: 302,
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				clientId: c.env.SPOTIFY_CLIENT_ID,
				redirectUri: new URL("/callback", c.req.url).href,
				scope: SPOTIFY_SCOPES,
				state: stateToken,
			}),
		},
	});
}

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Skip the approval dialog for clients the user already approved.
	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToSpotify(c, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: SERVER_INFO,
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();

		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToSpotify(c, stateToken, Object.fromEntries(headers));
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text(`Internal server error: ${error.message}`, 500);
	}
});

/**
 * OAuth callback from Spotify. Validates the state (KV + session cookie),
 * exchanges the code for tokens, fetches the user's profile, and stores both
 * on the issued MCP token via `props`.
 */
app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const spotifyError = c.req.query("error");
	if (spotifyError) {
		return c.text(`Spotify authorization failed: ${spotifyError}`, 400);
	}

	const code = c.req.query("code");
	if (!code) {
		return c.text("Missing authorization code", 400);
	}

	let tokens;
	try {
		tokens = await exchangeCodeForToken({
			clientId: c.env.SPOTIFY_CLIENT_ID,
			clientSecret: c.env.SPOTIFY_CLIENT_SECRET,
			code,
			redirectUri: new URL("/callback", c.req.url).href,
		});
	} catch (error: any) {
		console.error("Token exchange error:", error);
		return c.text(`Token exchange failed: ${error.message}`, 500);
	}

	// Fetch the user's profile to label the grant.
	const meResp = await fetch("https://api.spotify.com/v1/me", {
		headers: { Authorization: `Bearer ${tokens.accessToken}` },
	});
	if (!meResp.ok) {
		return c.text(`Failed to fetch Spotify profile: ${await meResp.text()}`, 500);
	}
	const me = (await meResp.json()) as { id: string; display_name?: string; email?: string };

	// Gate access to the allowlisted email(s). Reject before issuing any token.
	if (!isEmailAllowed(me.email, c.env.ALLOWED_EMAILS)) {
		return c.text(
			"Access denied: this Spotify account is not authorized to use this server.",
			403,
		);
	}

	const props: Props = {
		userId: me.id,
		displayName: me.display_name ?? me.id,
		email: me.email!,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken!,
		expiresAt: tokens.expiresAt,
	};

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: props.displayName },
		props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: props.userId,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, { status: 302, headers });
});

export { app as SpotifyHandler };
