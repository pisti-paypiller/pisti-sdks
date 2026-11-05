import { useState, type FormEvent } from "react";
import { useAccount, useAuth } from "./context.js";
import { ActionNotice, ErrorNotice, Loading, useAction, useResource } from "./ui.js";

const lifetimes = [
    { label: "Never expires", seconds: null },
    { label: "30 days", seconds: 30 * 86_400 },
    { label: "90 days", seconds: 90 * 86_400 },
    { label: "1 year", seconds: 365 * 86_400 },
] as const;

/**
 * Lets the signed-in user create, copy and revoke API keys for your API, like Clerk's `<APIKeys />`.
 * Your backend accepts them with `getAuth(req, { acceptsToken: "api_key" })`.
 */
export function APIKeys({ className = "" }: { className?: string }) {
    const account = useAccount();
    const { isLoaded, isSignedIn } = useAuth();
    const keys = useResource(account.apiKeys);
    const action = useAction();
    const [creating, setCreating] = useState(false);
    const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
    const [copied, setCopied] = useState(false);
    if (!isLoaded) return <Loading />;
    if (!isSignedIn) return <p>Sign in to manage your API keys.</p>;

    function create(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        const lifetime = lifetimes[Number(form.get("lifetime") ?? 0)]?.seconds ?? null;
        if (!name) return;
        void action.run(async () => {
            const created = await account.createApiKey({
                name,
                ...(lifetime ? { secondsUntilExpiration: lifetime } : {}),
            });
            setSecret({ name: created.apiKey.name, value: created.secret });
            setCopied(false);
            setCreating(false);
            keys.reload();
        });
    }

    return (
        <section className={"pisti-ui pisti-section " + className}>
            <h3>API keys</h3>
            <p className="pisti-muted">Keys let scripts and integrations call this app as you. Treat them like passwords.</p>
            {secret && (
                <div className="pisti-notice" role="status">
                    <p>
                        <strong>{secret.name}</strong> is ready. Copy it now: it won’t be shown again.
                    </p>
                    <code className="pisti-secret">{secret.value}</code>
                    <div className="pisti-actions">
                        <button
                            type="button"
                            className="pisti-secondary"
                            onClick={() =>
                                void navigator.clipboard?.writeText(secret.value).then(
                                    () => setCopied(true),
                                    () => setCopied(false),
                                )
                            }
                        >
                            {copied ? "Copied" : "Copy key"}
                        </button>
                        <button type="button" className="pisti-secondary" onClick={() => setSecret(null)}>
                            Done
                        </button>
                    </div>
                </div>
            )}
            {keys.isLoading && <Loading />}
            <ErrorNotice error={keys.error} retry={keys.reload} />
            <ActionNotice action={action} />
            {keys.data?.length === 0 && !creating && <p>You have no API keys yet.</p>}
            <ul className="pisti-list">
                {keys.data?.map((key) => (
                    <li key={key.id}>
                        <div>
                            {key.name}
                            <p className="pisti-muted">
                                <code>{key.keyPrefix}…</code> ·{" "}
                                {key.expired
                                    ? "Expired"
                                    : key.expiresAt
                                      ? `Expires ${new Date(key.expiresAt).toLocaleDateString()}`
                                      : "Never expires"}{" "}
                                · {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "Never used"}
                            </p>
                        </div>
                        <button
                            type="button"
                            className="pisti-secondary"
                            disabled={action.isPending}
                            onClick={() =>
                                void action.run(async () => {
                                    await account.revokeApiKey(key.id);
                                    keys.reload();
                                }, "API key revoked.")
                            }
                        >
                            Revoke
                        </button>
                    </li>
                ))}
            </ul>
            {creating ? (
                <form className="pisti-form" onSubmit={create}>
                    <label>
                        Name
                        <input name="name" required maxLength={100} placeholder="Deploy script" autoFocus />
                    </label>
                    <label>
                        Expiration
                        <select name="lifetime" defaultValue="0">
                            {lifetimes.map((lifetime, index) => (
                                <option key={lifetime.label} value={index}>
                                    {lifetime.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="pisti-actions">
                        <button type="submit" disabled={action.isPending}>
                            {action.isPending ? "Creating…" : "Create key"}
                        </button>
                        <button type="button" className="pisti-secondary" onClick={() => setCreating(false)}>
                            Cancel
                        </button>
                    </div>
                </form>
            ) : (
                <div className="pisti-actions">
                    <button type="button" onClick={() => setCreating(true)}>
                        New API key
                    </button>
                </div>
            )}
        </section>
    );
}
