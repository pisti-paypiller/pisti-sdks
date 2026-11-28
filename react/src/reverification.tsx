import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { PistiClient, SessionVerification } from "./client.js";
import { useAction } from "./async-state.js";

type FirstFactor = "password" | "email_code" | "passkey";
type SecondFactor = "totp" | "backup_code";

const labels: Record<FirstFactor | SecondFactor, string> = {
    password: "Password",
    email_code: "Email code",
    passkey: "Passkey",
    totp: "Authenticator app",
    backup_code: "Backup code",
};

/**
 * The reverification step: opens when a session API request answers `403 session_reverification_required`, verifies
 * the session at the level it asked for (`/v1/client/sessions/{id}/verify`), and lets the request run again.
 */
export function ReverificationDialog({ client }: { client: PistiClient }) {
    const requirement = useSyncExternalStore(
        client.subscribeReverification,
        client.getReverificationSnapshot,
        client.getServerReverificationSnapshot,
    );
    const dialog = useRef<HTMLDialogElement>(null);
    const id = useId();
    const action = useAction();
    const [verification, setVerification] = useState<SessionVerification | null>(null);
    const [first, setFirst] = useState<FirstFactor | null>(null);
    const [second, setSecond] = useState<SecondFactor | null>(null);
    const [codeSent, setCodeSent] = useState(false);

    useEffect(() => {
        const element = dialog.current;
        if (!element) return;
        if (requirement && !element.open) {
            action.reset();
            setVerification(null);
            setFirst(null);
            setSecond(null);
            setCodeSent(false);
            element.showModal();
            void action.run(async () => setVerification(await client.sessionVerification.create(requirement.level)));
        }
        if (!requirement && element.open) element.close();
    }, [requirement, client, action.reset]);

    const advance = async (next: SessionVerification) => {
        setVerification(next);
        if (next.status === "complete") await client.completeReverification(next);
    };
    const firstFactors = (verification?.supportedFirstFactors ?? [])
        .map((factor) => factor.strategy)
        .filter((strategy): strategy is FirstFactor => strategy in labels && strategy !== "totp" && strategy !== "backup_code")
        .filter((strategy) => strategy !== "passkey" || (typeof window !== "undefined" && "PublicKeyCredential" in window));
    const secondFactors = (verification?.supportedSecondFactors ?? [])
        .map((factor) => factor.strategy)
        .filter((strategy): strategy is SecondFactor => strategy === "totp" || strategy === "backup_code");
    const firstFactor = first ?? firstFactors[0] ?? null;
    const secondFactor = second ?? secondFactors[0] ?? null;

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const field = (name: string) => String(new FormData(form).get(name) ?? "").trim();
        void action.run(async () => {
            if (verification?.status === "needs_first_factor" && firstFactor === "password")
                await advance(await client.sessionVerification.attemptFirstFactor({ strategy: "password", password: field("password") }));
            else if (verification?.status === "needs_first_factor" && firstFactor === "email_code")
                await advance(await client.sessionVerification.attemptFirstFactor({ strategy: "email_code", code: field("code") }));
            else if (verification?.status === "needs_second_factor" && secondFactor)
                await advance(await client.sessionVerification.attemptSecondFactor({ strategy: secondFactor, code: field("code") }));
            form.reset();
        });
    };

    const step = verification?.status;
    return (
        <dialog
            ref={dialog}
            className="pisti-ui pisti-reverification"
            aria-labelledby={id + "-title"}
            onCancel={() => client.cancelReverification()}
            onClose={() => {
                if (client.getReverificationSnapshot()) client.cancelReverification();
            }}
        >
            <h2 id={id + "-title"}>Verify your identity</h2>
            <p className="pisti-muted">
                {step === "needs_second_factor"
                    ? "Enter a code from your authenticator app, or a backup code."
                    : "Confirm it's you before continuing with this action."}
            </p>
            {!verification && action.isPending && <p role="status">Loading…</p>}
            {step === "needs_first_factor" && firstFactors.length > 1 && (
                <div className="pisti-row" role="group" aria-label="Verification method">
                    {firstFactors.map((strategy) => (
                        <button
                            key={strategy}
                            type="button"
                            className="pisti-secondary"
                            aria-pressed={firstFactor === strategy}
                            onClick={() => {
                                setFirst(strategy);
                                setCodeSent(false);
                                action.reset();
                            }}
                        >
                            {labels[strategy]}
                        </button>
                    ))}
                </div>
            )}
            {step === "needs_second_factor" && secondFactors.length > 1 && (
                <div className="pisti-row" role="group" aria-label="Second factor">
                    {secondFactors.map((strategy) => (
                        <button
                            key={strategy}
                            type="button"
                            className="pisti-secondary"
                            aria-pressed={secondFactor === strategy}
                            onClick={() => setSecond(strategy)}
                        >
                            {labels[strategy]}
                        </button>
                    ))}
                </div>
            )}
            <form className="pisti-form" onSubmit={submit}>
                <fieldset disabled={action.isPending || !verification}>
                    {step === "needs_first_factor" && firstFactor === "password" && (
                        <label htmlFor={id + "-password"}>
                            Password
                            <input id={id + "-password"} name="password" type="password" maxLength={128} autoComplete="current-password" required />
                        </label>
                    )}
                    {step === "needs_first_factor" && firstFactor === "email_code" &&
                        (codeSent ? (
                            <label htmlFor={id + "-code"}>
                                Email verification code
                                <input id={id + "-code"} name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
                            </label>
                        ) : null)}
                    {step === "needs_first_factor" && firstFactor === "email_code" && (
                        <button
                            type="button"
                            className="pisti-secondary"
                            onClick={() =>
                                void action.run(async () => {
                                    setVerification(await client.sessionVerification.prepareFirstFactor("email_code"));
                                    setCodeSent(true);
                                }, "Check your primary email for a code.")
                            }
                        >
                            {codeSent ? "Send another code" : "Email me a code"}
                        </button>
                    )}
                    {step === "needs_first_factor" && firstFactor === "passkey" && (
                        <button
                            type="button"
                            onClick={() => void action.run(async () => advance(await client.sessionVerification.passkey()))}
                        >
                            Use a passkey
                        </button>
                    )}
                    {step === "needs_second_factor" && secondFactor && (
                        <label htmlFor={id + "-second"}>
                            {secondFactor === "totp" ? "Authenticator code" : "Backup code"}
                            <input
                                id={id + "-second"}
                                name="code"
                                maxLength={64}
                                autoComplete="one-time-code"
                                {...(secondFactor === "totp" ? { inputMode: "numeric" as const, pattern: "[0-9]{6}" } : {})}
                                required
                            />
                        </label>
                    )}
                    {step === "needs_first_factor" && firstFactors.length === 0 && (
                        <p className="pisti-notice pisti-error">No verification method is available for this account.</p>
                    )}
                    {action.error && (
                        <p className="pisti-notice pisti-error" role="alert">
                            {action.error.message}
                        </p>
                    )}
                    {action.success && (
                        <p className="pisti-notice" role="status">
                            {action.success}
                        </p>
                    )}
                    <div className="pisti-actions">
                        {(step === "needs_second_factor" ||
                            (step === "needs_first_factor" && (firstFactor === "password" || (firstFactor === "email_code" && codeSent)))) && (
                            <button type="submit">{action.isPending ? "Verifying…" : "Verify and continue"}</button>
                        )}
                        <button type="button" className="pisti-secondary" onClick={() => client.cancelReverification()}>
                            Cancel
                        </button>
                    </div>
                </fieldset>
            </form>
        </dialog>
    );
}
