import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { APIKeys } from "./api-keys.js";
import { useAuth, useMe, usePisti } from "./context.js";
import type { EnvironmentConfig } from "./types.js";
import type { UserEmailAddress, Me, TOTP } from "./resources.js";
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
                "Pisti backup codes\nKeep this file private. Each code works once.\n\n" +
                    codes.join("\n") +
                    "\n",
            ],
            { type: "text/plain;charset=utf-8" },
        ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "pisti-backup-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
    return (
        <div className="pisti-notice" role="status">
            <h4>Save your backup codes</h4>
            <p>These codes are shown only now. Keep them somewhere safe outside this browser; each works once.</p>
            <pre>{codes.join("\n")}</pre>
            <button type="button" className="pisti-secondary" onClick={() => downloadRecoveryCodes(codes)}>
                Download backup codes
            </button>
            <button type="button" className="pisti-secondary" onClick={onDone}>
                I've saved my codes
            </button>
        </div>
    );
}

function AccountProfile() {
    const me = useMe();
    const profile = useResource(me.get);
    const environment = useEnvironmentConfig();
    const action = useAction();
    const id = useId();
    if (profile.isLoading && !profile.data) return <Loading />;
    if (!profile.data) return <ErrorNotice error={profile.error} retry={profile.reload} />;
    const data = profile.data;
    const usernames = environment?.signUp.username ?? "off";
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const username = value(form, "username").trim();
        void action.run(async () => {
            await me.update({
                firstName: value(form, "firstName"),
                lastName: value(form, "lastName"),
                imageUrl: value(form, "imageUrl"),
                // Changing the username needs a recent first factor, so it is sent only when it changed.
                ...(usernames !== "off" && username !== (data.username ?? "") ? { username } : {}),
                expectedUpdatedAt: data.updatedAt,
            });
            profile.reload();
        }, "Your profile has been updated.");
    };
    return (
        <section>
            <h2>Profile</h2>
            <p className="pisti-muted">{data.emailAddresses.find((address) => address.id === data.primaryEmailAddressId)?.emailAddress}</p>
            <form className="pisti-form" onSubmit={submit} key={data.updatedAt}>
                <fieldset disabled={action.isPending}>
                    <legend>Personal information</legend>
                    <div className="pisti-grid">
                        <label htmlFor={id + "-first"}>
                            First name
                            <input id={id + "-first"} name="firstName" defaultValue={data.firstName} maxLength={100} autoComplete="given-name" />
                        </label>
                        <label htmlFor={id + "-last"}>
                            Last name
                            <input id={id + "-last"} name="lastName" defaultValue={data.lastName} maxLength={100} autoComplete="family-name" />
                        </label>
                    </div>
                    <label htmlFor={id + "-image"}>
                        Profile image URL
                        <input id={id + "-image"} name="imageUrl" type="url" defaultValue={data.imageUrl ?? ""} maxLength={2048} />
                    </label>
                    {usernames !== "off" && (
                        <label htmlFor={id + "-username"}>
                            Username
                            <input
                                id={id + "-username"}
                                name="username"
                                defaultValue={data.username ?? ""}
                                minLength={3}
                                maxLength={64}
                                autoComplete="username"
                                required={usernames === "required"}
                            />
                        </label>
                    )}
                    <button type="submit">{action.isPending ? "Saving…" : "Save profile"}</button>
                </fieldset>
                <ActionNotice action={action} />
            </form>
        </section>
    );
}

function AccountSessions() {
    const me = useMe();
    const [cursors, setCursors] = useState<string[]>([]);
    const cursor = cursors[cursors.length - 1];
    const load = useCallback(() => me.getSessions({ limit: 10, ...(cursor ? { cursor } : {}) }), [me, cursor]);
    const query = useResource(load);
    const action = useAction();
    return (
        <section>
            <h2>Sessions</h2>
            <p className="pisti-muted">Your devices. Seeing and ending them may ask you to verify your identity.</p>
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            {query.data && (
                <>
                    <ul className="pisti-list">
                        {query.data.items.map((session) => (
                            <li key={session.id}>
                                <div>
                                    <strong>{session.current ? "This device" : session.device}</strong>
                                    <p className="pisti-muted">
                                        {session.current ? session.device : ""}
                                        {session.ipAddress ? `${session.current ? " · " : ""}${session.ipAddress}` : ""}
                                    </p>
                                    <p className="pisti-muted">
                                        Last active {new Date(session.lastSeenAt).toLocaleString()}
                                        {session.status !== "active" ? ` · ${session.status.replace("_", " ")}` : ""}
                                    </p>
                                </div>
                                {session.status === "active" && !session.current && (
                                    <button
                                        type="button"
                                        className="pisti-secondary"
                                        disabled={action.isPending}
                                        onClick={() =>
                                            void action.run(async () => {
                                                await me.revokeSession(session.id);
                                                query.reload();
                                            }, "The session has ended.")
                                        }
                                    >
                                        Sign out
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
                            disabled={cursors.length === 0 || query.isLoading}
                            onClick={() => setCursors(cursors.slice(0, -1))}
                        >
                            Previous
                        </button>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={!query.data.hasMore || !query.data.nextCursor || query.isLoading}
                            onClick={() => query.data?.nextCursor && setCursors([...cursors, query.data.nextCursor])}
                        >
                            Next
                        </button>
                    </div>
                    <button type="button" className="pisti-danger" disabled={action.isPending} onClick={() => void action.run(me.revokeAllSessions)}>
                        Sign out everywhere
                    </button>
                </>
            )}
        </section>
    );
}

function AccountPasskeys() {
    const me = useMe();
    const query = useResource(me.getPasskeys);
    const action = useAction();
    const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
    return (
        <section className="pisti-section">
            <h3>Passkeys</h3>
            <p className="pisti-muted">Use a fingerprint, face, device PIN or security key instead of a password.</p>
            {supported && (
                <form
                    className="pisti-row"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const name = value(form, "name").trim() || "Passkey";
                        void action.run(async () => {
                            await me.createPasskey({ name });
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
                            <p className="pisti-muted">
                                {passkey.lastUsedAt ? `Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}` : "Never used"}
                            </p>
                        </div>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={action.isPending}
                            onClick={() =>
                                void action.run(async () => {
                                    await me.deletePasskey(passkey.id);
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

function AccountEmailAddresses({ profile }: { profile: { data: Me | null; reload: () => void } }) {
    const me = useMe();
    const query = useResource(me.getEmailAddresses);
    const action = useAction();
    const [pending, setPending] = useState<UserEmailAddress | null>(null);
    const reload = () => {
        query.reload();
        profile.reload();
    };
    return (
        <section className="pisti-section">
            <h3>Email addresses</h3>
            <p className="pisti-muted">Sign in with any verified address. Pisti writes to your primary address.</p>
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            <ul className="pisti-list">
                {query.data?.map((address) => (
                    <li key={address.id}>
                        <div>
                            {address.emailAddress}
                            <p className="pisti-muted">
                                {address.primary ? "Primary" : address.verification.status === "verified" ? "Verified" : "Not verified"}
                            </p>
                        </div>
                        {!address.primary && (
                            <div className="pisti-row">
                                {address.verification.status === "verified" ? (
                                    <button
                                        type="button"
                                        className="pisti-secondary"
                                        disabled={action.isPending}
                                        onClick={() =>
                                            void action.run(async () => {
                                                await me.update({ primaryEmailAddressId: address.id });
                                                reload();
                                            }, "Primary address changed.")
                                        }
                                    >
                                        Make primary
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="pisti-secondary"
                                        disabled={action.isPending}
                                        onClick={() =>
                                            void action.run(async () => setPending(await address.prepareVerification()), "Check that inbox for a code.")
                                        }
                                    >
                                        Verify
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="pisti-secondary"
                                    disabled={action.isPending}
                                    onClick={() =>
                                        void action.run(async () => {
                                            await address.destroy();
                                            if (pending?.id === address.id) setPending(null);
                                            reload();
                                        }, "Address removed.")
                                    }
                                >
                                    Remove
                                </button>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
            <form
                className="pisti-row"
                onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    void action.run(async () => {
                        if (pending) {
                            await pending.attemptVerification({ code: value(form, "code").trim() });
                            setPending(null);
                        } else {
                            setPending(await me.createEmailAddress({ emailAddress: value(form, "emailAddress").trim() }));
                        }
                        form.reset();
                        reload();
                    }, pending ? "Address verified." : "Check that inbox for a code.");
                }}
            >
                {pending ? (
                    <input
                        name="code"
                        aria-label={`Code sent to ${pending.emailAddress}`}
                        placeholder="6-digit code"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        autoComplete="one-time-code"
                        required
                    />
                ) : (
                    <input name="emailAddress" type="email" aria-label="Email address to add" placeholder="Add an email address" maxLength={254} required />
                )}
                <button type="submit" className="pisti-secondary" disabled={action.isPending}>
                    {pending ? "Verify" : "Add"}
                </button>
                {pending && (
                    <button type="button" className="pisti-link" onClick={() => setPending(null)}>
                        Cancel
                    </button>
                )}
            </form>
        </section>
    );
}

function AccountConnections() {
    const me = useMe();
    const environment = useEnvironmentConfig();
    const query = useResource(me.getExternalAccounts);
    const action = useAction();
    const connected = typeof location !== "undefined" ? new URLSearchParams(location.search).get("__pisti_connection") : null;
    const available = (environment?.signIn.providers ?? []).filter(
        (provider) => !query.data?.some((connection) => "oauth_" + connection.providerId === provider.strategy),
    );
    return (
        <section className="pisti-section">
            <h3>Connected accounts</h3>
            <p className="pisti-muted">Sign in with a provider you connect here. Disconnecting one ends all your sessions.</p>
            {connected && (
                <p className="pisti-notice" role="status">
                    {connected === "connected"
                        ? "Provider connected."
                        : connected === "connection_in_use"
                          ? "That provider account is already connected to another user."
                          : "The provider couldn’t be connected. Try again."}
                </p>
            )}
            {available.map((provider) => (
                <button
                    key={provider.strategy}
                    type="button"
                    className="pisti-secondary"
                    disabled={action.isPending}
                    onClick={() =>
                        void action.run(async () => {
                            const started = await me.createExternalAccount({ strategy: provider.strategy, redirectUrl: location.href });
                            location.assign(started.externalVerificationRedirectUrl);
                        })
                    }
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
                            {connection.email && <p className="pisti-muted">{connection.email}</p>}
                        </div>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={action.isPending}
                            onClick={() => void action.run(() => me.deleteExternalAccount(connection.id))}
                        >
                            Disconnect and sign out
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function AccountTwoStep({ profile }: { profile: { data: Me | null; reload: () => void } }) {
    const me = useMe();
    const environment = useEnvironmentConfig();
    const action = useAction();
    const id = useId();
    const [totp, setTotp] = useState<TOTP | null>(null);
    const [codes, setCodes] = useState<string[]>([]);
    const data = profile.data;
    if (!data) return null;
    return (
        <section className="pisti-section">
            <h3>Two-step verification</h3>
            <p className="pisti-muted">
                {data.totpEnabled ? "Authenticator app enabled." : "Protect your account with an authenticator app."}
                {environment?.requireMfa ? " Your application requires this protection." : ""}
            </p>
            <ActionNotice action={action} />
            {!totp && (
                <button
                    type="button"
                    className="pisti-secondary"
                    disabled={action.isPending}
                    onClick={() =>
                        void action.run(async () => {
                            setTotp(await me.createTOTP());
                            setCodes([]);
                        }, "Add the setup key to your authenticator app.")
                    }
                >
                    {data.totpEnabled ? "Replace authenticator" : "Set up authenticator"}
                </button>
            )}
            {totp && (
                <form
                    className="pisti-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        void action.run(async () => {
                            setCodes((await me.verifyTOTP({ code: value(form, "code") })).codes);
                            setTotp(null);
                            form.reset();
                            profile.reload();
                        }, "Authenticator enabled. Your other devices were signed out.");
                    }}
                >
                    <fieldset disabled={action.isPending}>
                        <legend>Confirm authenticator</legend>
                        <label htmlFor={id + "-key"}>
                            Setup key
                            <input id={id + "-key"} value={totp.secret} readOnly autoComplete="off" />
                        </label>
                        <p className="pisti-muted">
                            Use “Enter a setup key” in your authenticator app, or <a href={totp.uri}>open it in the app</a>. This setup
                            expires at {new Date(totp.expiresAt).toLocaleTimeString()}.
                        </p>
                        <label htmlFor={id + "-code"}>
                            Authenticator code
                            <input id={id + "-code"} name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
                        </label>
                        <div className="pisti-actions">
                            <button type="submit">Confirm authenticator</button>
                            <button type="button" className="pisti-secondary" onClick={() => setTotp(null)}>
                                Cancel setup
                            </button>
                        </div>
                    </fieldset>
                </form>
            )}
            {data.totpEnabled && !totp && (
                <div className="pisti-actions">
                    <button
                        type="button"
                        className="pisti-secondary"
                        disabled={action.isPending}
                        onClick={() =>
                            void action.run(async () => {
                                setCodes((await me.createBackupCode()).codes);
                                profile.reload();
                            }, "Your previous backup codes no longer work.")
                        }
                    >
                        {data.backupCodeEnabled ? "Replace backup codes" : "Create backup codes"}
                    </button>
                    {!environment?.requireMfa && (
                        <button
                            type="button"
                            className="pisti-danger"
                            disabled={action.isPending}
                            onClick={() => void action.run(() => me.disableTOTP())}
                        >
                            Remove authenticator and sign out
                        </button>
                    )}
                </div>
            )}
            {codes.length > 0 && <Codes codes={codes} onDone={() => setCodes([])} />}
        </section>
    );
}

function AccountSecurity() {
    const me = useMe();
    const profile = useResource(me.get);
    const environment = useEnvironmentConfig();
    const action = useAction();
    const id = useId();
    return (
        <section>
            <h2>Security</h2>
            <p className="pisti-muted">Changes here may ask you to verify your identity first.</p>
            {profile.isLoading && !profile.data && <Loading />}
            <ErrorNotice error={profile.error} retry={profile.reload} />
            <AccountEmailAddresses profile={profile} />
            <AccountPasskeys />
            <AccountConnections />
            <AccountTwoStep profile={profile} />
            {environment?.signIn.password && profile.data && (
                <details className="pisti-section">
                    <summary>{profile.data.passwordEnabled ? "Change password" : "Set a password"}</summary>
                    <p className="pisti-muted">Saving a password signs out your other devices; this one stays signed in.</p>
                    <form
                        className="pisti-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            void action.run(async () => {
                                await me.updatePassword({ newPassword: value(form, "newPassword") });
                                form.reset();
                                profile.reload();
                            }, "Your password has been saved.");
                        }}
                    >
                        <fieldset disabled={action.isPending}>
                            <label htmlFor={id + "-new"}>
                                New password
                                <input id={id + "-new"} name="newPassword" type="password" minLength={15} maxLength={128} autoComplete="new-password" required />
                            </label>
                            <button type="submit">Save password</button>
                        </fieldset>
                    </form>
                </details>
            )}
            <details className="pisti-section">
                <summary>Deactivate account</summary>
                <p className="pisti-muted">
                    Deactivation signs you out everywhere. Your account is permanently deleted after 30 days; until then you can
                    reactivate it from the sign-in page with an email code.
                </p>
                <form
                    className="pisti-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void action.run(() => me.delete());
                    }}
                >
                    <fieldset disabled={action.isPending}>
                        <label>
                            <input type="checkbox" required /> I understand that I will lose access to this account.
                        </label>
                        <button type="submit" className="pisti-danger">
                            Deactivate account
                        </button>
                    </fieldset>
                </form>
            </details>
            <ActionNotice action={action} />
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
