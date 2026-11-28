import type { components } from "./generated/frontend.js";

type FrontendSchemas = components["schemas"];

export interface EmailAddress {
    emailAddress: string;
}

export interface PistiUser {
    id: string;
    firstName: string;
    lastName: string;
    fullName: string | null;
    primaryEmailAddress: EmailAddress | null;
    /** The user's username, where the environment uses them. */
    username: string | null;
    imageUrl: string | null;
    hasImage: boolean;
    issuer: string;
    authenticatedAt: number | null;
    instanceId: string;
    organizationId: string | null;
    organizationSlug: string | null;
    organizationRole: string | null;
    organizationPermissions: readonly string[];
}

export interface RedirectOptions {
    /** Always go here afterwards, ignoring `redirect_url`. */
    forceRedirectUrl?: string | undefined;
    /** Go here afterwards when there is no `redirect_url`. */
    fallbackRedirectUrl?: string | undefined;
}

/**
 * Navigation settings, named like Clerk's. Each also reads a `VITE_PISTI_*` environment variable,
 * for example `VITE_PISTI_SIGN_IN_URL`, and falls back to Domains & paths in the console.
 */
export interface PistiNavigationOptions {
    /** Your sign-in page, for example "/sign-in". Without one, sign-in opens in a modal. */
    signInUrl?: string | undefined;
    /** Your sign-up page. */
    signUpUrl?: string | undefined;
    /** After sign-in when there is no `redirect_url`. Defaults to "/". */
    signInFallbackRedirectUrl?: string | undefined;
    /** After sign-up when there is no `redirect_url`. Defaults to "/". */
    signUpFallbackRedirectUrl?: string | undefined;
    /** Always go here after sign-in. */
    signInForceRedirectUrl?: string | undefined;
    /** Always go here after sign-up. */
    signUpForceRedirectUrl?: string | undefined;
    /** After sign-out. Defaults to "/". */
    afterSignOutUrl?: string | undefined;
    /** Other origins a `redirect_url` may point to. Same-origin URLs are always allowed. */
    allowedRedirectOrigins?: Array<string | RegExp> | undefined;
    /** Your router's push navigation, so redirects don't reload the page. */
    routerPush?: ((to: string) => unknown) | undefined;
    /** Your router's replace navigation. Defaults to routerPush. */
    routerReplace?: ((to: string) => unknown) | undefined;
}

export interface PistiClientOptions extends PistiNavigationOptions {
    /** Defaults to the `VITE_PISTI_PUBLISHABLE_KEY` (or `PISTI_PUBLISHABLE_KEY`) environment variable. */
    publishableKey?: string | undefined;
}

export type PistiModal = "sign-in" | "sign-up" | "user-profile" | null;

export interface AuthSnapshot {
    status: "loading" | "signedIn" | "signedOut" | "error";
    isLoaded: boolean;
    isSignedIn: boolean;
    user: PistiUser | null;
    sessionId: string | null;
    /** Claims of the latest session token. */
    sessionClaims: Readonly<Record<string, unknown>> | null;
    /** Minutes since the session last verified its first and second factor (`-1` for never), as Clerk's
     * `session.factorVerificationAge`. Sensitive actions need it within their window, or reverification. */
    factorVerificationAge: readonly [number, number] | null;
    error: Error | null;
}

/** The environment's sign-in, sign-up and navigation settings, from `GET /v1/environment`. */
export type EnvironmentConfig = FrontendSchemas["EnvironmentResponse"];

export type SignInResult =
    | { status: "complete"; recoveryCodes?: string[] | null }
    | {
          status: "needs_second_factor";
          attemptId: string;
          enrollmentRequired: boolean;
      };

/** The second factor a sign-in needs. After a password sign-in, adding an authenticator also needs the code Pisti
 * emailed to the user (`emailCodeRequired`). `expiresAt` is when the sign-in attempt expires. */
export type SecondFactorDetails = FrontendSchemas["SecondFactorSetup"] & { expiresAt?: string };

export interface SignUpInput {
    requestId: string;
    username?: string;
    code: string;
    firstName?: string;
    lastName?: string;
    password?: string;
}

export interface GetTokenOptions {
    skipCache?: boolean;
}

export interface PermissionCheck {
    permission?: string;
    role?: string;
}
