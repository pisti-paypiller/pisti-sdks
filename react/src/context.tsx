import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type ReactNode,
} from "react";
import { PistiClient } from "./client.js";
import { ReverificationDialog } from "./reverification.js";
import { ModalContext, SignIn, SignUp } from "./auth.js";
import { UserProfile } from "./user-profile.js";
import type { PistiClientOptions } from "./types.js";

const PistiContext = createContext<PistiClient | null>(null);

export interface PistiAppearance {
    variables?: {
        /** Buttons, links and focus rings. */
        colorPrimary?: string;
        /** Text on primary buttons. */
        colorPrimaryText?: string;
        colorBackground?: string;
        colorText?: string;
        colorTextSecondary?: string;
        colorBorder?: string;
        borderRadius?: string;
        fontFamily?: string;
    };
}

export interface PistiProviderProps extends PistiClientOptions {
    children: ReactNode;
    /** Colors, radius and font for every Pisti component. */
    appearance?: PistiAppearance;
}

/**
 * Makes Pisti available to your app. With no props it reads `VITE_PISTI_PUBLISHABLE_KEY`, like
 * Clerk's provider reads `VITE_CLERK_PUBLISHABLE_KEY`.
 */
export function PistiProvider({
    publishableKey,
    children,
    appearance,
    ...navigation
}: PistiProviderProps) {
    const client = useMemo(() => new PistiClient({ ...(publishableKey ? { publishableKey } : {}), ...navigation }), [publishableKey]);
    // Keep the latest URLs and router functions without recreating the client on every render.
    client.configure(navigation);
    useEffect(() => client.start(), [client]);
    const variables = appearance?.variables;
    const style = variables
        ? ({
              display: "contents",
              ...(variables.colorPrimary ? { "--pisti-brand": variables.colorPrimary } : {}),
              ...(variables.colorPrimaryText ? { "--pisti-brand-text": variables.colorPrimaryText } : {}),
              ...(variables.colorBackground ? { "--pisti-color-background": variables.colorBackground } : {}),
              ...(variables.colorText ? { "--pisti-color-text": variables.colorText } : {}),
              ...(variables.colorTextSecondary ? { "--pisti-color-muted": variables.colorTextSecondary } : {}),
              ...(variables.colorBorder ? { "--pisti-color-border": variables.colorBorder } : {}),
              ...(variables.borderRadius ? { "--pisti-radius": variables.borderRadius } : {}),
              ...(variables.fontFamily ? { "--pisti-font": variables.fontFamily } : {}),
          } as CSSProperties)
        : undefined;
    const content = (
        <>
            {children}
            <ModalHost client={client} />
            <ReverificationDialog client={client} />
        </>
    );
    return (
        <PistiContext.Provider value={client}>{style ? <div style={style}>{content}</div> : content}</PistiContext.Provider>
    );
}

/** One dialog for sign-in, sign-up and the user profile, opened with client.openSignIn() and friends. */
function ModalHost({ client }: { client: PistiClient }) {
    const modal = useSyncExternalStore(client.subscribeModal, client.getModal, client.getServerModal);
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        if (!element) return;
        if (modal && !element.open) element.showModal();
        if (!modal && element.open) element.close();
    }, [modal]);
    return (
        <dialog
            ref={dialog}
            className="pisti-modal"
            onClose={() => client.closeModal()}
            onClick={(event) => {
                if (event.target === event.currentTarget) client.closeModal();
            }}
        >
            <ModalContext.Provider value>
                {modal === "sign-in" && <SignIn />}
                {modal === "sign-up" && <SignUp />}
                {modal === "user-profile" && (
                    <div className="pisti-modal-panel">
                        <button type="button" className="pisti-link pisti-modal-close" onClick={() => client.closeModal()}>
                            Close
                        </button>
                        <UserProfile />
                    </div>
                )}
            </ModalContext.Provider>
        </dialog>
    );
}

/** The Pisti client: openSignIn(), openUserProfile(), redirectToSignIn(), signOut(), getToken() and more. */
export function usePisti(): PistiClient {
    const client = useContext(PistiContext);
    if (!client) throw new Error("Pisti hooks and components must be inside <PistiProvider>.");
    return client;
}

export function useAuth() {
    const client = usePisti();
    const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
    return {
        ...snapshot,
        userId: snapshot.user?.id ?? null,
        orgId: snapshot.user?.organizationId ?? null,
        orgSlug: snapshot.user?.organizationSlug ?? null,
        orgRole: snapshot.user?.organizationRole ?? null,
        has: client.has,
        getToken: client.getToken,
        signOut: client.signOut,
        reload: client.load,
    };
}

export function useUser() {
    const { isLoaded, isSignedIn, user, error, reload } = useAuth();
    return { isLoaded, isSignedIn, user, error, reload };
}

/** The current session: its id, the signed-in user and its `factorVerificationAge` (minutes since the first and second
 * factor were last verified, `-1` for never). */
export function useSession() {
    const { isLoaded, isSignedIn, sessionId, user, factorVerificationAge } = useAuth();
    return { isLoaded, isSignedIn, session: sessionId && user ? { id: sessionId, user, factorVerificationAge } : null };
}

/** Low-level sign-in steps, for building your own sign-in form. */
export function useSignIn() {
    return usePisti().signIn;
}

/** Low-level sign-up steps, for building your own sign-up form. */
export function useSignUp() {
    return usePisti().signUp;
}

export function useAuthenticatedFetch(): PistiClient["authenticatedFetch"] {
    return usePisti().authenticatedFetch;
}

/** The signed-in user's own resources (`/v1/me`): profile, email addresses, passkeys, authenticator, backup codes,
 * provider accounts, sessions, API keys and organization memberships. */
export function useMe() {
    return usePisti().me;
}

/**
 * Wraps `operation` like Clerk's `useReverification`: when it fails with `session_reverification_required` (any error
 * whose `code` is that, with `reverification: { level, afterMinutes }`), the provider shows the reverification step
 * and `operation` runs again once the session is verified. Pisti's own resources already do this.
 */
export function useReverification<Arguments extends unknown[], Result>(operation: (...args: Arguments) => Promise<Result>) {
    const client = usePisti();
    return useCallback((...args: Arguments): Promise<Result> => client.withReverification(() => operation(...args)), [client, operation]);
}

export function useOrganizationList() {
    return usePisti().organizations;
}

/**
 * The environment's organization settings, from `/v1/environment`: `enabled` is false while the environment has
 * organizations turned off, and `isLoaded` false until the environment is loaded. The organization components render
 * nothing while organizations are off.
 */
export function useOrganizationSettings(): {
    isLoaded: boolean;
    enabled: boolean;
    allowUserCreation: boolean;
    membershipLimit: number | null;
} {
    const client = usePisti();
    const [environment, setEnvironment] = useState(client.environment);
    useEffect(() => {
        let active = true;
        client.loadEnvironment().then((value) => active && setEnvironment(value), () => {});
        return () => {
            active = false;
        };
    }, [client]);
    const organizations = environment?.organizations ?? null;
    return {
        isLoaded: environment !== null,
        enabled: organizations !== null,
        allowUserCreation: organizations?.allowUserCreation ?? false,
        membershipLimit: organizations?.membershipLimit ?? null,
    };
}

export function useOrganization() {
    const { user, isLoaded, isSignedIn } = useAuth();
    const client = usePisti();
    return {
        isLoaded,
        isSignedIn,
        organizationId: user?.organizationId ?? null,
        role: user?.organizationRole ?? null,
        permissions: user?.organizationPermissions ?? [],
        setActive: client.setActiveOrganization,
    };
}
