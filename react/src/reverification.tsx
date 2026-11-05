import {
    useEffect,
    useId,
    useRef,
    useState,
    useSyncExternalStore,
    type FormEvent,
} from "react";
import type { PistiClient } from "./client.js";
import { useAction } from "./async-state.js";

export function ReverificationDialog({ client }: { client: PistiClient }) {
    const required = useSyncExternalStore(
        client.subscribeReverification,
        client.getReverificationSnapshot,
        client.getServerReverificationSnapshot,
    );
    const dialog = useRef<HTMLDialogElement>(null);
    const form = useRef<HTMLFormElement>(null);
    const id = useId();
    const action = useAction();
    const [requestId, setRequestId] = useState<string | null>(null);
    useEffect(() => {
        const element = dialog.current;
        if (!element) return;
        if (required && !element.open) {
            action.reset();
            element.showModal();
        }
        if (!required && element.open) {
            element.close();
            form.current?.reset();
            setRequestId(null);
        }
    }, [required, action.reset]);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const element = event.currentTarget;
        const fields = new FormData(element);
        const code = String(fields.get("factor") ?? "");
        void action.run(async () => {
            await client.completeReverification({
                ...(requestId
                    ? {
                          requestId,
                          emailCode: String(fields.get("emailCode") ?? ""),
                      }
                    : { password: String(fields.get("password") ?? "") }),
                ...(code ? { code } : {}),
            });
            element.reset();
        });
    };
    return (
        <dialog
            ref={dialog}
            className="pisti-ui pisti-reverification"
            aria-labelledby={id + "-title"}
            onCancel={() => client.cancelReverification()}
            onClose={() => {
                if (client.getReverificationSnapshot())
                    client.cancelReverification();
            }}
        >
            <h2 id={id + "-title"}>Verify your identity</h2>
            <p className="pisti-muted">
                Confirm it's you before continuing with this action.
            </p>
            <form ref={form} className="pisti-form" onSubmit={submit}>
                <fieldset disabled={action.isPending}>
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
                    ) : (
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
                    )}
                    <button
                        type="button"
                        className="pisti-secondary"
                        onClick={() =>
                            void action.run(async () => {
                                setRequestId(
                                    (
                                        await client.account.requestReauthentication()
                                    ).requestId,
                                );
                            })
                        }
                    >
                        {requestId
                            ? "Send another email code"
                            : "Use an email code instead"}
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
                        Required if you have enrolled an authenticator.
                    </p>
                    {action.error && (
                        <p className="pisti-notice pisti-error" role="alert">
                            {action.error.message}
                        </p>
                    )}
                    <div className="pisti-actions">
                        <button type="submit">
                            {action.isPending
                                ? "Verifying…"
                                : "Verify and continue"}
                        </button>
                        <button
                            type="button"
                            className="pisti-secondary"
                            onClick={() => client.cancelReverification()}
                        >
                            Cancel
                        </button>
                    </div>
                </fieldset>
            </form>
            <button
                type="button"
                className="pisti-secondary"
                disabled={action.isPending}
                onClick={() => void action.run(() => client.reauthenticate())}
            >
                Use a passkey or another method
            </button>
            <p className="pisti-muted">
                Using another sign-in method returns you to the application,
                where you can retry your action.
            </p>
        </dialog>
    );
}
