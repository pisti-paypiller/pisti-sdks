import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";

/** The test environment's generated development host. */
export const HOST_ORIGIN = "http://quiet-fox-12.pisti.localhost:3000";
/** The management API the tests point the SDK at. */
export const API_ORIGIN = "http://localhost:3000";
export const ISSUER = `${HOST_ORIGIN}/`;
export const APP_ORIGIN = "http://localhost:5173";

/** A development publishable key for the test environment, built the way the backend encodes it. */
export function publishableKey(environment: "test" | "live" = "test"): string {
    const origin = environment === "test" ? HOST_ORIGIN : "https://auth.example.com";
    const encoded = Buffer.from(`${origin}$`, "utf8").toString("base64url");
    return `pk_${environment}_${encoded}`;
}

export interface SigningKey {
    privateKey: CryptoKey;
    /** The PEM public key, passed to the SDK as `jwtKey` so verification never touches the network. */
    pem: string;
}

export async function signingKey(algorithm: "RS256" | "ES256" = "ES256"): Promise<SigningKey> {
    const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });
    return { privateKey, pem: await exportSPKI(publicKey) };
}

export interface TokenOptions {
    algorithm?: "RS256" | "ES256";
    type?: string;
    issuer?: string;
    audience?: string;
    expiresInSeconds?: number;
    issuedAt?: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** The JOSE type and audience the backend gives each kind of token. */
export const KINDS = {
    session: { type: "session+jwt", audience: "pisti:session" },
    access: { type: "at+jwt", audience: "urn:instance:test" },
} as const;

/** Signs a JWT with the given claims, typed as a session token unless the options say otherwise. */
export function sign(key: SigningKey, claims: JWTPayload, options: TokenOptions = {}): Promise<string> {
    const issuedAt = options.issuedAt ?? now();
    return new SignJWT(claims)
        .setProtectedHeader({ alg: options.algorithm ?? "ES256", typ: options.type ?? KINDS.session.type })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? KINDS.session.audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + (options.expiresInSeconds ?? 60))
        .sign(key.privateKey);
}

/** The claims of a valid session token for the test environment. */
export function sessionClaims(overrides: JWTPayload = {}): JWTPayload {
    return {
        sub: "user_1",
        sid: "sess_1",
        instance_id: "ins_1",
        ptyp: "session",
        azp: APP_ORIGIN,
        auth_time: now(),
        ...overrides,
    };
}
