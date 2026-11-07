export interface PublishableKeyInfo {
    environment: "test" | "live";
    /** The environment's Frontend API, for example https://api.pisti.com/v1/fapi/fa_123. */
    frontendApi: URL;
    frontendApiId: string;
    /** The Pisti API base URL, for example https://api.pisti.com/. */
    apiUrl: URL;
    /** This environment's own token issuer, for example https://api.pisti.com/i/fa_123. Its published keys sign
     * the environment's session, OAuth and M2M tokens, and no other environment's. */
    issuer: URL;
}

/** Publishable keys are `pk_test_` or `pk_live_` followed by the base64url Frontend API URL and a `$`. */
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
    const frontendApi = new URL(decoded.slice(0, -1));
    const segments = frontendApi.pathname.split("/").filter(Boolean);
    const frontendApiId = segments.at(-1) ?? "";
    if (
        segments.length < 3 ||
        segments.at(-2) !== "fapi" ||
        segments.at(-3) !== "v1" ||
        !/^[A-Za-z0-9_-]{3,64}$/.test(frontendApiId)
    )
        throw new Error("The publishable key is malformed.");
    const environment = match[1] as "test" | "live";
    trustedUrl(frontendApi.origin, environment === "test");
    const apiUrl = new URL(
        frontendApi.pathname.slice(
            0,
            frontendApi.pathname.length - `v1/fapi/${frontendApiId}`.length,
        ),
        frontendApi.origin,
    );
    const issuer = new URL(`i/${frontendApiId}`, apiUrl);
    return { environment, frontendApi, frontendApiId, apiUrl, issuer };
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
