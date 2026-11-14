import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { APIKeys } from "./api-keys.js";
import { useAccount, useAuth, usePisti } from "./context.js";
import type { EnvironmentConfig } from "./types.js";
import type { AuthenticatorEnrollment, SecurityProof } from "./resources.js";
import {
    ActionNotice,
    ErrorNotice,
    Loading,
    useAction,
    useResource,
} from "./ui.js";

function value(form: HTMLFormElement, name: string): string {
    return String(new FormData(form).get(name) ?? "");
}

function downloadRecoveryCodes(codes: string[]) {
    const url = URL.createObjectURL(
        new Blob(
            [
                "Pisti recovery codes\nKeep this file private. Each code works once.\n\n" +
                    codes.join("\n") +
                    "\n",
            ],
            { type: "text/plain;charset=utf-8" },
        ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "pisti-recovery-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Collects the proof that every security change needs in the same request: the current password or
 * an email code, plus an authenticator or recovery code when one is enrolled. `children` holds the
 * operation's own fields, read from the form passed to `onSubmit`. */
function ProofForm({
    label,
    onSubmit,
    message,
    hasPassword = true,
    children,
}: {
    label: string;
    onSubmit: (proof: SecurityProof, form: HTMLFormElement) => Promise<void>;
    message: string;
    hasPassword?: boolean | undefined;
    children?: ReactNode;
}) {
    const account = useAccount();
    const id = useId();
    const action = useAction();
    const [requestId, setRequestId] = useState<string | null>(null);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        void action.run(async () => {
            const code = value(form, "factor");
            await onSubmit(
                {
                    ...(requestId
                        ? { requestId, emailCode: value(form, "emailCode") }
                        : { password: value(form, "password") }),
                    ...(code ? { code } : {}),
                },
                form,
            );
            form.reset();
            setRequestId(null);
        }, message);
    };
    return (
        <form onSubmit={submit} className="pisti-form">
            <fieldset disabled={action.isPending}>
                <legend>{label}</legend>
                {children}
                {requestId ? (
                    <label htmlFor={id + "-email"}>
                        Email verification code
                        <input
                            id={id + "-email"}
                            name="emailCode"
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            autoComplete="one-time-code"
                            required
                        />
                    </label>
                ) : hasPassword ? (
                    <label htmlFor={id + "-password"}>
                        Current password
                        <input
                            id={id + "-password"}
                            name="password"
                            type="password"
                            maxLength={128}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                ) : (
                    <p className="pisti-muted">
                        Confirm it's you with a code sent to your verified email.
                    </p>
                )}
                <button
                    type="button"
                    className="pisti-secondary"
                    onClick={() =>
                        void action.run(async () => {
                            const request =
                                await account.requestReauthentication();
                            setRequestId(request.requestId);
                        }, "Check your verified email for a code.")
                    }
                >
                    {requestId
                        ? "Send a new email code"
                        : hasPassword
                          ? "Use an email code instead"
                          : "Send an email code"}
                </button>
                <label htmlFor={id + "-factor"}>
                    Authenticator or recovery code
                    <input
                        id={id + "-factor"}
                        name="factor"
                        maxLength={64}
                        autoComplete="one-time-code"
                    />
                </label>
                <p className="pisti-muted">
                    Enter your second factor if an authenticator is already
                    enrolled.
                </p>
                <button type="submit" disabled={!hasPassword && !requestId}>
                    {action.isPending ? "Verifying…" : label}
                </button>
            </fieldset>
            <ActionNotice action={action} />
        </form>
    );
}

function AccountProfile() {
    const account = useAccount();
    const profile = useResource(account.get);
    const action = useAction();
    const { user } = useAuth();
    const id = useId();
    if (profile.isLoading && !profile.data) return <Loading />;
    if (!profile.data)
        return <ErrorNotice error={profile.error} retry={profile.reload} />;
    const data = profile.data;
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        void action.run(async () => {
            await account.update({
                firstName: value(form, "firstName"),
                lastName: value(form, "lastName"),
                imageUrl: value(form, "imageUrl") || null,
                unsafeMetadata: data.unsafeMetadata,
                expectedUpdatedAt: data.updatedAt,
            });
            profile.reload();
        }, "Your profile has been updated.");
    };
    return (
        <section>
            <h2>Profile</h2>
            <p className="pisti-muted">{user?.primaryEmailAddress?.emailAddress}</p>
            <form className="pisti-form" onSubmit={submit} key={data.updatedAt}>
                <fieldset disabled={action.isPending}>
                    <legend>Personal information</legend>
                    <div className="pisti-grid">
                        <label htmlFor={id + "-first"}>
                            First name
                            <input
                                id={id + "-first"}
                                name="firstName"
                                defaultValue={data.firstName}
                                maxLength={100}
                                autoComplete="given-name"
                            />
                        </label>
                        <label htmlFor={id + "-last"}>
                            Last name
                            <input
                                id={id + "-last"}
                                name="lastName"
                                defaultValue={data.lastName}
                                maxLength={100}
                                autoComplete="family-name"
                            />
                        </label>
                    </div>
                    <label htmlFor={id + "-image"}>
                        Profile image URL
                        <input
                            id={id + "-image"}
                            name="imageUrl"
                            type="url"
                            defaultValue={data.imageUrl ?? ""}
                            maxLength={2048}
                        />
                    </label>
                    <button type="submit">
                        {action.isPending ? "Saving…" : "Save profile"}
                    </button>
                </fieldset>
                <ActionNotice action={action} />
                <ErrorNotice error={profile.error} retry={profile.reload} />
            </form>
        </section>
    );
}

function AccountSessions() {
    const account = useAccount();
    const [page, setPage] = useState(1);
    const load = useCallback(() => account.sessions(page, 10), [account, page]);
    const query = useResource(load);
    const action = useAction();
    return (
        <section>
            <h2>Sessions</h2>
            <p className="pisti-muted">
                Revoke sessions you no longer use. Recent identity verification
                is required.
            </p>
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            {query.data && (
                <>
                    <ul className="pisti-list">
                        {query.data.items.map((session) => (
                            <li key={session.id}>
                                <div>
                                    <strong>
                                        {session.current
                                            ? "This session"
                                            : "Application session"}
                                    </strong>
                                    <p className="pisti-muted">
                                        {session.device}
                                        {session.ipAddress
                                            ? ` · ${session.ipAddress}`
                                            : ""}
                                    </p>
                                    <p className="pisti-muted">
                                        Last active{" "}
                                        {new Date(
                                            session.lastSeenAt,
                                        ).toLocaleString()}
                                        {session.status === "revoked" ? " · Revoked" : ""}
                                    </p>
                                </div>
                                {!session.endedAt && (
                                    <button
                                        type="button"
                                        className="pisti-secondary"
                                        disabled={action.isPending}
                                        onClick={() =>
                                            void action.run(async () => {
                                                await account.revokeSession(
                                                    session.id,
                                                );
                                                query.reload();
                                            }, "The session has ended.")
                                        }
                                    >
                                        Revoke
                                        {session.current ? " this session" : ""}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                    {query.data.items.length === 0 && <p>No sessions found.</p>}
                    <div className="pisti-actions">
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={page === 1 || query.isLoading}
                            onClick={() => setPage(page - 1)}
                        >
                            Previous
                        </button>
                        <span>Page {page}</span>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={
                                page * 10 >= query.data.totalCount ||
                                query.isLoading
                            }
                            onClick={() => setPage(page + 1)}
                        >
                            Next
                        </button>
                    </div>
                    <button
                        type="button"
                        className="pisti-danger"
                        disabled={action.isPending}
                        onClick={() =>
                            void action.run(account.revokeAllSessions)
                        }
                    >
                        Sign out all sessions
                    </button>
                </>
            )}
        </section>
    );
}

function AccountPasskeys() {
    const account = useAccount();
    const { user } = useAuth();
    const query = useResource(account.passkeys);
    const action = useAction();
    if (!user) return null;
    const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
    return (
        <section className="pisti-section">
            <h3>Passkeys</h3>
            <p className="pisti-muted">
                Use a fingerprint, face, device PIN or security key instead of a
                password.
            </p>
            {supported && (
                <form
                    className="pisti-row"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const name = String(new FormData(form).get("name") ?? "").trim() || "Passkey";
                        void action.run(async () => {
                            await account.addPasskey(name);
                            form.reset();
                            query.reload();
                        }, "Passkey added.");
                    }}
                >
                    <input name="name" aria-label="Passkey name" placeholder="Name, such as My laptop" maxLength={100} />
                    <button type="submit" className="pisti-secondary" disabled={action.isPending}>
                        Add a passkey
                    </button>
                </form>
            )}
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            {query.data?.length === 0 && <p>No passkeys registered.</p>}
            <ul className="pisti-list">
                {query.data?.map((passkey) => (
                    <li key={passkey.id}>
                        <div>
                            {passkey.name}
                            <p className="pisti-muted">{passkey.rpId}</p>
                        </div>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={action.isPending}
                            onClick={() =>
                                void action.run(async () => {
                                    await account.removePasskey(passkey.id);
                                    query.reload();
                                }, "Passkey removed.")
                            }
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function AccountConnections() {
    const account = useAccount();
    const { user, reload } = useAuth();
    const environment = useEnvironmentConfig();
    const query = useResource(account.connections);
    const action = useAction();
    if (!user) return null;
    const connected = typeof location !== "undefined" ? new URLSearchParams(location.search).get("__pisti_connection") : null;
    const available = (environment?.signIn.providers ?? []).filter(
        (provider) => !query.data?.some((connection) => connection.providerId === provider.strategy.slice("oauth_".length)),
    );
    return (
        <section className="pisti-section">
            <h3>Connected accounts</h3>
            <p className="pisti-muted">
                Sign in with a provider you connect here. Connecting needs a
                recent sign-in; disconnecting ends all your sessions.
            </p>
            {connected && (
                <p className="pisti-notice" role="status">
                    {connected === "connected" ? "Provider connected." : connected === "connection_in_use"
                        ? "That provider account is already connected to another user." : "The provider couldn’t be connected. Try again."}
                </p>
            )}
            {available.map((provider) => (
                <button
                    key={provider.strategy}
                    type="button"
                    className="pisti-secondary"
                    disabled={action.isPending}
                    onClick={() => void action.run(async () => { await account.connect(Number(provider.strategy.slice("oauth_".length))); }, "")}
                >
                    Connect {provider.name}
                </button>
            ))}
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            {query.data?.length === 0 && <p>No sign-in providers connected.</p>}
            <ul className="pisti-list">
                {query.data?.map((connection) => (
                    <li key={connection.id}>
                        <div>
                            <strong>{connection.displayName}</strong>
                            {connection.email && (
                                <p className="pisti-muted">
                                    {connection.email}
                                </p>
                            )}
                        </div>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={action.isPending}
                            onClick={() =>
                                void action.run(async () => {
                                    await account.disconnect(connection.id);
                                    await reload();
                                    query.reload();
                                }, "Provider disconnected. Sign in again using another method.")
                            }
                        >
                            Disconnect and sign out
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function AccountSecurity() {
    const account = useAccount();
    const query = useResource(account.security);
    const action = useAction();
    const [enrollment, setEnrollment] =
        useState<AuthenticatorEnrollment | null>(null);
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [emailRequest, setEmailRequest] = useState<string | null>(null);
    const [deactivationRequest, setDeactivationRequest] = useState<
        string | null
    >(null);
    const id = useId();
    return (
        <section>
            <h2>Security</h2>
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            <AccountPasskeys />
            <AccountConnections />
            <ProofForm
                hasPassword={query.data?.hasPassword}
                label="Verify identity"
                message="Your identity has been verified."
                onSubmit={async (proof) => {
                    await account.reauthenticate(proof);
                    query.reload();
                }}
            />
            <section className="pisti-section">
                <h3>Two-step verification</h3>
                <p className="pisti-muted">
                    {query.data?.authenticatorEnabled
                        ? "Authenticator enabled."
                        : "Protect your account with an authenticator app."}
                    {query.data?.authenticatorRequired
                        ? " Your application requires this protection."
                        : ""}
                </p>
                {!enrollment && (
                    <ProofForm
                        hasPassword={query.data?.hasPassword}
                        label={
                            query.data?.authenticatorEnabled
                                ? "Replace authenticator"
                                : "Set up authenticator"
                        }
                        message="Add the setup key to your authenticator app."
                        onSubmit={async (proof) => {
                            setEnrollment(
                                await account.enrollAuthenticator(proof),
                            );
                            setRecoveryCodes([]);
                        }}
                    />
                )}
                {enrollment && (
                    <form
                        className="pisti-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            void action.run(async () => {
                                const result =
                                    await account.confirmAuthenticator(
                                        enrollment.enrollmentId,
                                        value(form, "code"),
                                    );
                                setRecoveryCodes(result.recoveryCodes);
                                setEnrollment(null);
                                form.reset();
                                query.reload();
                            }, "Authenticator enabled.");
                        }}
                    >
                        <fieldset disabled={action.isPending}>
                            <legend>Confirm authenticator</legend>
                            <label htmlFor={id + "-key"}>
                                Setup key
                                <input
                                    id={id + "-key"}
                                    value={enrollment.setupKey}
                                    readOnly
                                    autoComplete="off"
                                />
                            </label>
                            <p className="pisti-muted">
                                Use “Enter a setup key” in your authenticator
                                app. This setup expires shortly.
                            </p>
                            <label htmlFor={id + "-code"}>
                                Authenticator code
                                <input
                                    id={id + "-code"}
                                    name="code"
                                    inputMode="numeric"
                                    pattern="[0-9]{6}"
                                    maxLength={6}
                                    autoComplete="one-time-code"
                                    required
                                />
                            </label>
                            <div className="pisti-actions">
                                <button type="submit">
                                    Confirm authenticator
                                </button>
                                <button
                                    type="button"
                                    className="pisti-secondary"
                                    onClick={() => setEnrollment(null)}
                                >
                                    Cancel setup
                                </button>
                            </div>
                        </fieldset>
                    </form>
                )}
                {query.data?.authenticatorEnabled && (
                    <details>
                        <summary>
                            Recovery codes and authenticator removal
                        </summary>
                        <p className="pisti-muted">
                            {query.data.recoveryCodesRemaining} unused recovery
                            codes remain. Each authenticator code is accepted
                            once; wait for a fresh code between operations.
                        </p>
                        <ProofForm
                            hasPassword={query.data.hasPassword}
                            label="Generate new recovery codes"
                            message="Previous recovery codes have been replaced."
                            onSubmit={async (proof) => {
                                setRecoveryCodes(
                                    (
                                        await account.regenerateRecoveryCodes(
                                            proof,
                                        )
                                    ).recoveryCodes,
                                );
                                query.reload();
                            }}
                        />
                        {!query.data.authenticatorRequired && (
                            <ProofForm
                                hasPassword={query.data.hasPassword}
                                label="Remove authenticator and sign out"
                                message="Authenticator removed."
                                onSubmit={async (proof) => {
                                    await account.removeAuthenticator(proof);
                                    query.reload();
                                }}
                            />
                        )}
                    </details>
                )}
                {recoveryCodes.length > 0 && (
                    <div className="pisti-notice" role="status">
                        <h4>Save your recovery codes</h4>
                        <p>
                            These codes are shown only now. Keep them somewhere
                            safe outside this browser.
                        </p>
                        <pre>{recoveryCodes.join("\n")}</pre>
                        <button
                            type="button"
                            className="pisti-secondary"
                            onClick={() => downloadRecoveryCodes(recoveryCodes)}
                        >
                            Download recovery codes
                        </button>
                        <button
                            type="button"
                            className="pisti-secondary"
                            onClick={() => setRecoveryCodes([])}
                        >
                            I've saved my codes
                        </button>
                    </div>
                )}
            </section>
            {query.data?.passwordEnabled && (
                <details className="pisti-section">
                    <summary>
                        {query.data.hasPassword
                            ? "Change password"
                            : "Set a password"}
                    </summary>
                    <p className="pisti-muted">
                        Changing your password signs out your other devices; this one stays signed in.
                    </p>
                    <ProofForm
                        hasPassword={query.data.hasPassword}
                        label={
                            query.data.hasPassword
                                ? "Change password and sign out"
                                : "Set password and sign out"
                        }
                        message="Your password has been saved."
                        onSubmit={(proof, form) =>
                            account.setPassword(value(form, "password"), proof)
                        }
                    >
                        <label htmlFor={id + "-new"}>
                            New password
                            <input
                                id={id + "-new"}
                                name="password"
                                type="password"
                                minLength={15}
                                maxLength={128}
                                autoComplete="new-password"
                                required
                            />
                        </label>
                    </ProofForm>
                </details>
            )}
            <details className="pisti-section">
                <summary>Change email</summary>
                <p className="pisti-muted">
                    Verify your new address. Your previous address receives a
                    security notification. Your old email will stop working and
                    all sessions will end.
                </p>
                {!emailRequest ? (
                    <ProofForm
                        hasPassword={query.data?.hasPassword}
                        label="Send verification code"
                        message="Check your new email for a code."
                        onSubmit={async (proof, form) => {
                            setEmailRequest(
                                (
                                    await account.requestEmailChange(
                                        value(form, "email"),
                                        proof,
                                    )
                                ).requestId,
                            );
                        }}
                    >
                        <label htmlFor={id + "-email"}>
                            New email
                            <input
                                id={id + "-email"}
                                name="email"
                                type="email"
                                maxLength={254}
                                autoComplete="email"
                                required
                            />
                        </label>
                    </ProofForm>
                ) : (
                    <form
                        className="pisti-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            void action.run(async () => {
                                await account.completeEmailChange(
                                    emailRequest,
                                    value(form, "code"),
                                );
                                form.reset();
                            });
                        }}
                    >
                        <fieldset disabled={action.isPending}>
                            <label htmlFor={id + "-email-code"}>
                                Email verification code
                                <input
                                    id={id + "-email-code"}
                                    name="code"
                                    pattern="[0-9]{6}"
                                    maxLength={6}
                                    autoComplete="one-time-code"
                                    required
                                />
                            </label>
                            <button type="submit">
                                Change email and sign out
                            </button>
                            <button
                                type="button"
                                className="pisti-secondary"
                                onClick={() => setEmailRequest(null)}
                            >
                                Start again
                            </button>
                        </fieldset>
                    </form>
                )}
            </details>
            <details className="pisti-section">
                <summary>Deactivate account</summary>
                <p className="pisti-muted">
                    Deactivation signs you out everywhere. Your account is
                    permanently deleted after 30 days; until then you can
                    reactivate it from the sign-in page with an email code.
                </p>
                {!deactivationRequest ? (
                    <button
                        type="button"
                        className="pisti-danger"
                        disabled={action.isPending}
                        onClick={() =>
                            void action.run(async () => {
                                setDeactivationRequest(
                                    (await account.requestDeactivation())
                                        .requestId,
                                );
                            }, "A confirmation code will be sent to your email.")
                        }
                    >
                        Request deactivation code
                    </button>
                ) : (
                    <form
                        className="pisti-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            void action.run(async () => {
                                await account.deactivate(
                                    deactivationRequest,
                                    value(form, "code"),
                                );
                                form.reset();
                            });
                        }}
                    >
                        <fieldset disabled={action.isPending}>
                            <label htmlFor={id + "-delete-code"}>
                                Email confirmation code
                                <input
                                    id={id + "-delete-code"}
                                    name="code"
                                    pattern="[0-9]{6}"
                                    maxLength={6}
                                    autoComplete="one-time-code"
                                    required
                                />
                            </label>
                            <label>
                                <input type="checkbox" required /> I understand
                                that I will lose access to this account.
                            </label>
                            <button type="submit" className="pisti-danger">
                                Deactivate account
                            </button>
                        </fieldset>
                    </form>
                )}
            </details>
        </section>
    );
}

export function UserProfile({
    className = "",
    apiKeys = false,
}: {
    className?: string;
    /** Adds an "API keys" page with <APIKeys />. */
    apiKeys?: boolean;
}) {
    const { isLoaded, isSignedIn, error, user, sessionId } = useAuth();
    const [page, setPage] = useState<"profile" | "security" | "sessions" | "api keys">(
        "profile",
    );
    const pages = apiKeys
        ? (["profile", "security", "sessions", "api keys"] as const)
        : (["profile", "security", "sessions"] as const);
    if (!isLoaded) return <Loading />;
    if (error) return <ErrorNotice error={error} />;
    if (!isSignedIn) return <p>Sign in to manage your account.</p>;
    return (
        <div
            key={user?.id + ":" + sessionId}
            className={"pisti-ui pisti-account " + className}
        >
            <header>
                <h1>Your account</h1>
                <p className="pisti-muted">
                    Manage your profile, security and sessions.
                </p>
            </header>
            <nav className="pisti-navigation" aria-label="Account settings">
                {pages.map((item) => (
                    <button
                        type="button"
                        className="pisti-secondary"
                        key={item}
                        aria-current={page === item ? "page" : undefined}
                        onClick={() => setPage(item)}
                    >
                        {item === "api keys" ? "API keys" : item.charAt(0).toUpperCase() + item.slice(1)}
                    </button>
                ))}
            </nav>
            {page === "profile" ? (
                <AccountProfile />
            ) : page === "security" ? (
                <AccountSecurity />
            ) : page === "api keys" ? (
                <APIKeys />
            ) : (
                <AccountSessions />
            )}
        </div>
    );
}

/** The environment's configuration, loaded once per client. */
function useEnvironmentConfig(): EnvironmentConfig | null {
    const client = usePisti();
    const [environment, setEnvironment] = useState<EnvironmentConfig | null>(null);
    useEffect(() => {
        let active = true;
        client.loadEnvironment().then((value) => active && setEnvironment(value), () => {});
        return () => {
            active = false;
        };
    }, [client]);
    return environment;
}
