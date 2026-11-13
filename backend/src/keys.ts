export interface PublishableKeyInfo {
    environment: "test" | "live";
    /** The environment's own host, for example https://auth.acme.com. Its Frontend API and account API are `/v1/…` there. */
    frontendApi: URL;
    /** This environment's own token issuer: its host with a trailing slash, for example https://auth.acme.com/. Its
     * published keys sign the environment's session, OAuth and M2M tokens, and no other environment's. */
    issuer: URL;
}

/** Where the Pisti management API lives unless `apiUrl` or `PISTI_API_URL` says otherwise. */
export const DEFAULT_API_URL = "https://pisti-api.paypiller.com/";

/** Publishable keys are `pk_test_` or `pk_live_` followed by the base64url of the environment's host URL and a `$`. */
export function parsePublishableKey(key: string): PublishableKeyInfo {
    const match =
        typeof key === "string"
            ? /^pk_(test|live)_([A-Za-z0-9_-]+)$/.exec(key.trim())
            : null;
    if (!match)
        throw new Error(
            "Provide a Pisti publishable key that starts with pk_test_ or pk_live_.",
        );
    let decoded: string;
    try {
        decoded = Buffer.from(match[2]!, "base64url").toString("utf8");
    } catch {
        throw new Error("The publishable key is malformed.");
    }
    if (!decoded.endsWith("$"))
        throw new Error("The publishable key is malformed.");
    let host: URL;
    try {
        host = new URL(decoded.slice(0, -1));
    } catch {
        throw new Error("The publishable key is malformed.");
    }
    if (host.pathname !== "/" || host.search || host.hash)
        throw new Error("The publishable key is malformed.");
    const environment = match[1] as "test" | "live";
    trustedUrl(host.origin, environment === "test");
    return { environment, frontendApi: new URL(host.origin), issuer: new URL(`${host.origin}/`) };
}

/** The management API's base URL: `apiUrl`, else `PISTI_API_URL`, else Pisti's own. */
export function apiUrlFrom(value: string | undefined, development: boolean): URL {
    const url = trustedUrl(value ?? DEFAULT_API_URL, development);
    if (url.pathname !== "/") throw new Error("The Pisti API URL must have no path, for example https://pisti-api.paypiller.com.");
    return url;
}

export function trustedUrl(value: string, development: boolean): URL {
    if (typeof value !== "string" || value.length > 2048)
        throw new Error("Provide a URL of at most 2048 characters.");
    const url = new URL(value);
    const loopback =
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.hostname.endsWith(".localhost");
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(development && loopback && url.protocol === "http:"))
    )
        throw new Error(
            "Pisti URLs must use HTTPS; development keys also allow http://localhost.",
        );
    return url;
}
