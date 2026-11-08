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
    /** Handles `#pisti_invitation=` organization invitation links before rendering your app. Defaults to true. */
    handleInvitations?: boolean;
}

/**
 * Makes Pisti available to your app. With no props it reads `VITE_PISTI_PUBLISHABLE_KEY`, like
 * Clerk's provider reads `VITE_CLERK_PUBLISHABLE_KEY`.
 */
export function PistiProvider({
    publishableKey,
    children,
    appearance,
    handleInvitations = true,
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
            {handleInvitations ? <InvitationGate client={client}>{children}</InvitationGate> : children}
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

function InvitationGate({ client, children }: { client: PistiClient; children: ReactNode }) {
    const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
    const [token, setToken] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The token arrives in the fragment, so it never reaches your server's logs or a Referer header.
    useEffect(() => {
        setToken(new URLSearchParams(window.location.hash.slice(1)).get("pisti_invitation"));
    }, []);
    if (!token) return children;
    const clear = () => {
        const url = new URL(window.location.href);
        const fragment = new URLSearchParams(url.hash.slice(1));
        fragment.delete("pisti_invitation");
        url.hash = fragment.toString();
        window.history.replaceState(window.history.state, "", url.href);
        setToken(null);
    };
    const valid = /^[a-fA-F0-9]{64}$/.test(token);
    if (snapshot.isLoaded && !snapshot.isSignedIn) return <SignIn forceRedirectUrl={window.location.href} />;
    return (
        <section className="pisti-ui pisti-card">
            <header className="pisti-card-header">
                <h1>Join your organization</h1>
                <p className="pisti-muted">
                    {snapshot.user ? <>Signed in as {snapshot.user.primaryEmailAddress?.emailAddress}.</> : "Loading your account…"}
                </p>
            </header>
            {(!valid || error) && (
                <p className="pisti-notice pisti-error" role="alert">
                    {!valid ? "This invitation link is invalid." : error}
                </p>
            )}
            <div className="pisti-form">
                <button
                    type="button"
                    disabled={pending || !valid || !snapshot.isSignedIn}
                    onClick={() => {
                        setPending(true);
                        setError(null);
                        client.organizations
                            .acceptInvitation(token)
                            .then(() => client.getToken({ skipCache: true }))
                            .then(clear, (failure: unknown) =>
                                setError(failure instanceof Error ? failure.message : "The invitation could not be accepted."),
                            )
                            .finally(() => setPending(false));
                    }}
                >
                    {pending ? "Joining…" : "Accept invitation"}
                </button>
                <button type="button" className="pisti-secondary" disabled={pending} onClick={() => void client.signOut()}>
                    Use a different account
                </button>
                <button type="button" className="pisti-link" onClick={clear}>
                    Not now
                </button>
            </div>
        </section>
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

/** The current session: its id and the signed-in user. */
export function useSession() {
    const { isLoaded, isSignedIn, sessionId, user } = useAuth();
    return { isLoaded, isSignedIn, session: sessionId && user ? { id: sessionId, user } : null };
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

export function useAccount() {
    return usePisti().account;
}

export function useReverification<Arguments extends unknown[], Result>(operation: (...args: Arguments) => Promise<Result>) {
    const client = usePisti();
    return useCallback((...args: Arguments): Promise<Result> => client.withReverification(() => operation(...args)), [client, operation]);
}

export function useOrganizationList() {
    return usePisti().organizations;
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
