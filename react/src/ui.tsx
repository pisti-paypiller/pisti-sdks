import {
    cloneElement,
    isValidElement,
    useEffect,
    type ButtonHTMLAttributes,
    type MouseEvent,
    type ReactElement,
    type ReactNode,
} from "react";
import { useAuth, usePisti } from "./context.js";
import { useAction } from "./async-state.js";
export { useAction, useResource } from "./async-state.js";

export function ErrorNotice({
    error,
    retry,
}: {
    error: Error | null;
    retry?: () => void;
}) {
    return error ? (
        <div className="pisti-notice pisti-error" role="alert">
            {error.message}
            {retry && (
                <button type="button" onClick={retry}>
                    Try again
                </button>
            )}
        </div>
    ) : null;
}
export function ActionNotice({
    action,
}: {
    action: ReturnType<typeof useAction>;
}) {
    return (
        <>
            <ErrorNotice error={action.error} />
            {action.success && (
                <p className="pisti-notice" role="status">
                    {action.success}
                </p>
            )}
        </>
    );
}
export function Loading() {
    return (
        <p role="status" aria-live="polite">
            Loading…
        </p>
    );
}
export type ShowWhen =
    | "signed-in"
    | "signed-out"
    | { permission: string }
    | { role: string }
    | ((has: (check: { permission?: string; role?: string }) => boolean) => boolean);

/**
 * Renders its children when the condition holds, like Clerk's `<Show>`. It only hides UI; check
 * access on your server too.
 *
 * ```tsx
 * <Show when="signed-in"><UserButton /></Show>
 * <Show when={{ permission: "invoices:write" }} fallback={<p>No access</p>}>…</Show>
 * ```
 */
export function Show({ when, fallback = null, children }: { when: ShowWhen; fallback?: ReactNode; children: ReactNode }) {
    const auth = useAuth();
    if (!auth.isLoaded) return null;
    if (when === "signed-out") return !auth.isSignedIn && !auth.error ? children : fallback;
    if (!auth.isSignedIn) return fallback;
    if (when === "signed-in") return children;
    const allowed =
        typeof when === "function"
            ? when((check) => auth.has(check))
            : auth.has("permission" in when ? { permission: when.permission } : { role: when.role });
    return allowed ? children : fallback;
}

type TriggerProps = { children?: ReactNode };

/** Renders the child element with the click handler, or a plain button around text. */
function Trigger({
    children,
    label,
    onClick,
    props,
}: {
    children: ReactNode;
    label: string;
    onClick: () => void;
    props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">;
}) {
    if (isValidElement(children)) {
        const child = children as ReactElement<{ onClick?: (event: MouseEvent) => void }>;
        return cloneElement(child, {
            onClick: (event: MouseEvent) => {
                child.props.onClick?.(event);
                if (!event.defaultPrevented) onClick();
            },
        });
    }
    return (
        <button {...props} type="button" onClick={onClick}>
            {children ?? label}
        </button>
    );
}

type AuthButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> &
    TriggerProps & {
        /** "redirect" (the default when you have a sign-in page) or "modal". */
        mode?: "modal" | "redirect";
        forceRedirectUrl?: string;
        fallbackRedirectUrl?: string;
    };

function redirectsFrom(props: { forceRedirectUrl?: string | undefined; fallbackRedirectUrl?: string | undefined }) {
    return {
        ...(props.forceRedirectUrl ? { forceRedirectUrl: props.forceRedirectUrl } : {}),
        ...(props.fallbackRedirectUrl ? { fallbackRedirectUrl: props.fallbackRedirectUrl } : {}),
    };
}

/** Opens sign-in, like Clerk's `<SignInButton>`. Pass your own button as the child to style it. */
export function SignInButton({ mode, forceRedirectUrl, fallbackRedirectUrl, children, ...props }: AuthButtonProps) {
    const client = usePisti();
    return (
        <Trigger
            label="Sign in"
            props={props}
            onClick={() =>
                (mode ?? (client.signInUrl ? "redirect" : "modal")) === "redirect" && client.signInUrl
                    ? client.redirectToSignIn()
                    : client.openSignIn(redirectsFrom({ forceRedirectUrl, fallbackRedirectUrl }))
            }
        >
            {children}
        </Trigger>
    );
}

/** Opens sign-up, like Clerk's `<SignUpButton>`. */
export function SignUpButton({ mode, forceRedirectUrl, fallbackRedirectUrl, children, ...props }: AuthButtonProps) {
    const client = usePisti();
    return (
        <Trigger
            label="Sign up"
            props={props}
            onClick={() =>
                (mode ?? (client.signUpUrl ? "redirect" : "modal")) === "redirect" && client.signUpUrl
                    ? client.redirectToSignUp()
                    : client.openSignUp(redirectsFrom({ forceRedirectUrl, fallbackRedirectUrl }))
            }
        >
            {children}
        </Trigger>
    );
}

/** Sends visitors to sign-in as soon as it renders. Use it inside `<Show when="signed-out">`. */
export function RedirectToSignIn() {
    const client = usePisti();
    useEffect(() => client.redirectToSignIn(), [client]);
    return null;
}

/** Sends visitors to sign-up as soon as it renders. */
export function RedirectToSignUp() {
    const client = usePisti();
    useEffect(() => client.redirectToSignUp(), [client]);
    return null;
}

/** Renders its children once Pisti knows whether someone is signed in, like `<ClerkLoaded>`. */
export function PistiLoaded({ children }: { children: ReactNode }) {
    return useAuth().isLoaded ? children : null;
}

/** Renders its children until Pisti knows whether someone is signed in, like `<ClerkLoading>`. */
export function PistiLoading({ children }: { children: ReactNode }) {
    return useAuth().isLoaded ? null : children;
}

/** Signs out, then goes to `redirectUrl` or the provider's `afterSignOutUrl`, like Clerk's `<SignOutButton>`. */
export function SignOutButton({
    children,
    redirectUrl,
    ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> & TriggerProps & { redirectUrl?: string }) {
    const client = usePisti();
    const action = useAction();
    return (
        <>
            <Trigger
                label={action.isPending ? "Signing out…" : "Sign out"}
                props={{ ...props, disabled: Boolean(props.disabled) || action.isPending }}
                onClick={() =>
                    void action.run(async () => {
                        await client.signOut();
                        if (redirectUrl) client.navigate(redirectUrl);
                        else client.redirectAfterSignOut();
                    })
                }
            >
                {children}
            </Trigger>
            <ErrorNotice error={action.error} />
        </>
    );
}

function initials(user: { firstName: string; lastName: string; primaryEmailAddress: { emailAddress: string } | null }) {
    const letters = (user.firstName[0] ?? "") + (user.lastName[0] ?? "");
    return (letters || user.primaryEmailAddress?.emailAddress[0] || "?").toUpperCase();
}

/** An avatar with the account menu, like Clerk's `<UserButton>`. */
export function UserButton({
    userProfileMode,
    userProfileUrl,
    showName = false,
    className = "",
}: {
    /** "modal" opens <UserProfile /> in a dialog; "navigation" goes to `userProfileUrl`. */
    userProfileMode?: "modal" | "navigation";
    userProfileUrl?: string;
    /** Shows the user's name next to the avatar. */
    showName?: boolean;
    className?: string;
}) {
    const client = usePisti();
    const { user, isLoaded, isSignedIn } = useAuth();
    if (!isLoaded || !isSignedIn || !user) return null;
    const email = user.primaryEmailAddress?.emailAddress;
    const target = (userProfileMode ?? (userProfileUrl ? "navigation" : "modal")) === "navigation" ? userProfileUrl : undefined;
    return (
        <details className={"pisti-ui pisti-user-button " + className}>
            <summary aria-label="Open account menu">
                <span className="pisti-avatar">
                    {user.imageUrl ? <img src={user.imageUrl} alt="" /> : <span aria-hidden="true">{initials(user)}</span>}
                </span>
                {showName && <span className="pisti-user-name">{user.fullName ?? email}</span>}
            </summary>
            <div className="pisti-menu" role="menu">
                <div className="pisti-menu-identity">
                    <strong>{user.fullName || email}</strong>
                    {user.fullName && <span className="pisti-muted">{email}</span>}
                </div>
                <button
                    type="button"
                    role="menuitem"
                    className="pisti-menu-item"
                    onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        if (target) client.navigate(target);
                        else client.openUserProfile();
                    }}
                >
                    Manage account
                </button>
                <SignOutButton role="menuitem" className="pisti-menu-item" />
            </div>
        </details>
    );
}
