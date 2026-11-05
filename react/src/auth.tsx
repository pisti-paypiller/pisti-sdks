import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuth, usePisti } from "./context.js";
import { PistiClientError } from "./client.js";
import type { EnvironmentConfig, SignInResult } from "./types.js";

type Step =
    | { name: "start" }
    | { name: "email-code"; requestId: string; identifier: string }
    | {
          name: "second-factor";
          attemptId: string;
          enrollment: { setupKey: string | null; uri: string | null; emailCodeRequired: boolean } | null;
      }
    | { name: "recovery-codes"; codes: string[] }
    | { name: "reset"; identifier: string }
    | { name: "reset-code"; requestId: string; identifier: string }
    | { name: "reactivate"; identifier: string }
    | { name: "reactivate-code"; requestId: string; identifier: string };

/** Set by the provider's modal host, so the forms close the modal instead of redirecting. */
export const ModalContext = createContext(false);

export interface SignInProps {
    /** Always go here after signing in. */
    forceRedirectUrl?: string | undefined;
    /** Go here after signing in when there is no `redirect_url`. */
    fallbackRedirectUrl?: string | undefined;
    /** Where the "Sign up" link goes. Defaults to the provider's signUpUrl, else a modal. */
    signUpUrl?: string | undefined;
    className?: string | undefined;
}

export interface SignUpProps {
    forceRedirectUrl?: string | undefined;
    fallbackRedirectUrl?: string | undefined;
    /** Where the "Sign in" link goes. Defaults to the provider's signInUrl, else a modal. */
    signInUrl?: string | undefined;
    className?: string | undefined;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function useEnvironment(): { environment: EnvironmentConfig | null; error: string | null } {
    const client = usePisti();
    const [environment, setEnvironment] = useState(client.environment);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        client.loadEnvironment().then(
            (value) => active && setEnvironment(value),
            (failure: unknown) => active && setError(message(failure)),
        );
        return () => {
            active = false;
        };
    }, [client]);
    return { environment, error };
}

function Card({
    title,
    subtitle,
    children,
    footer,
    className = "",
}: {
    title: string;
    subtitle?: ReactNode | undefined;
    children: ReactNode;
    footer?: ReactNode | undefined;
    className?: string | undefined;
}) {
    return (
        <section className={"pisti-ui pisti-card " + className} aria-labelledby="pisti-card-title">
            <header className="pisti-card-header">
                <h1 id="pisti-card-title">{title}</h1>
                {subtitle && <p className="pisti-muted">{subtitle}</p>}
            </header>
            {children}
            {footer && <footer className="pisti-card-footer">{footer}</footer>}
            <p className="pisti-secured">Secured by Pisti</p>
        </section>
    );
}

function Field({
    label,
    hint,
    action,
    ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; action?: ReactNode }) {
    return (
        <label className="pisti-field">
            <span className="pisti-field-label">
                {label}
                {action}
            </span>
            <input {...input} />
            {hint && <span className="pisti-muted pisti-hint">{hint}</span>}
        </label>
    );
}

function CodeField({ label = "Code", autoFocus = true }: { label?: string; autoFocus?: boolean }) {
    return (
        <Field
            label={label}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus={autoFocus}
            className="pisti-code"
        />
    );
}

function Problem({ error }: { error: string | null }) {
    return error ? (
        <p className="pisti-notice pisti-error" role="alert">
            {error}
        </p>
    ) : null;
}

/** A complete sign-in form: password or email code, two-step verification and password reset. */
export function SignIn({ forceRedirectUrl, fallbackRedirectUrl, signUpUrl, className }: SignInProps) {
    const client = usePisti();
    const inModal = useContext(ModalContext);
    const { isLoaded, isSignedIn } = useAuth();
    const { environment, error: loadError } = useEnvironment();
    const [step, setStep] = useState<Step>({ name: "start" });
    const [identifier, setIdentifier] = useState("");
    const [useCode, setUseCode] = useState(false);
    const [useRecovery, setUseRecovery] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const finish = () => {
        if (inModal) {
            const options = client.getModalOptions();
            client.closeModal();
            if (options.forceRedirectUrl || options.fallbackRedirectUrl) client.redirectAfterSignIn(options);
        } else client.redirectAfterSignIn({ forceRedirectUrl, fallbackRedirectUrl });
    };
    // Arriving at the sign-in page already signed in continues to the app. Only the first
    // loaded state counts, so a sign-in completed here can still show recovery codes.
    const arrival = useRef(false);
    useEffect(() => {
        if (!isLoaded || arrival.current) return;
        arrival.current = true;
        if (isSignedIn) finish();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoaded, isSignedIn]);
    async function run(work: () => Promise<void>) {
        setPending(true);
        setError(null);
        try {
            await work();
        } catch (failure) {
            setError(message(failure));
        } finally {
            setPending(false);
        }
    }
    async function handle(result: SignInResult) {
        if (result.status === "complete") {
            if (result.recoveryCodes?.length) setStep({ name: "recovery-codes", codes: result.recoveryCodes });
            else finish();
            return;
        }
        const details = result.enrollmentRequired ? await client.signIn.secondFactorDetails(result.attemptId) : null;
        setStep({
            name: "second-factor",
            attemptId: result.attemptId,
            enrollment: details
                ? { setupKey: details.setupKey, uri: details.authenticatorUri, emailCodeRequired: details.emailCodeRequired }
                : null,
        });
    }

    if (!environment)
        return (
            <Card title="Sign in" className={className}>
                {loadError ? <Problem error={loadError} /> : <p className="pisti-muted" role="status">Loading…</p>}
            </Card>
        );

    const passwordEnabled = environment.signIn.password;
    const codeEnabled = environment.signIn.emailCode;
    const signUp = environment.signUp.enabled ? (
        <>
            Don’t have an account?{" "}
            <button
                type="button"
                className="pisti-link"
                onClick={() => {
                    const target = signUpUrl ?? client.signUpUrl;
                    if (inModal || !target) client.openSignUp(client.getModalOptions());
                    else client.navigate(target);
                }}
            >
                Sign up
            </button>
        </>
    ) : undefined;

    if (step.name === "recovery-codes")
        return (
            <Card title="Save your recovery codes" subtitle="Each code signs you in once if you lose your phone." className={className}>
                <ol className="pisti-codes">
                    {step.codes.map((code) => (
                        <li key={code}>{code}</li>
                    ))}
                </ol>
                <button type="button" onClick={finish}>
                    I’ve saved them
                </button>
            </Card>
        );

    if (step.name === "second-factor")
        return (
            <Card
                title={step.enrollment ? "Set up two-step verification" : "Two-step verification"}
                subtitle={
                    step.enrollment
                        ? "This app requires an authenticator. Add this key to your authenticator app, then enter the code it shows."
                        : useRecovery
                          ? "Enter one of your recovery codes."
                          : "Enter the code from your authenticator app."
                }
                className={className}
            >
                {step.enrollment?.setupKey && (
                    <div className="pisti-setup">
                        <code>{step.enrollment.setupKey}</code>
                        {step.enrollment.uri && (
                            <a href={step.enrollment.uri} className="pisti-link">
                                Open in authenticator app
                            </a>
                        )}
                    </div>
                )}
                <form
                    className="pisti-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        const code = String(form.get("code")).trim();
                        const emailCode = String(form.get("emailCode") ?? "").trim() || undefined;
                        void run(async () => handle(await client.signIn.completeSecondFactor(step.attemptId, code, emailCode)));
                    }}
                >
                    <fieldset disabled={pending}>
                        {step.enrollment?.emailCodeRequired && (
                            <Field
                                label="Code from your email"
                                hint="We emailed a code to confirm it’s you before adding an authenticator."
                                name="emailCode"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                pattern="[0-9]{6}"
                                maxLength={6}
                                required
                                autoFocus
                                className="pisti-code"
                            />
                        )}
                        {useRecovery ? (
                            <Field label="Recovery code" name="code" autoComplete="off" required autoFocus maxLength={64} />
                        ) : (
                            <CodeField
                                label={step.enrollment?.emailCodeRequired ? "Code from your authenticator app" : "Code"}
                                autoFocus={!step.enrollment?.emailCodeRequired}
                            />
                        )}
                    </fieldset>
                    <Problem error={error} />
                    <button type="submit" disabled={pending}>
                        {pending ? "Verifying…" : "Continue"}
                    </button>
                </form>
                <div className="pisti-row">
                    {!step.enrollment && (
                        <button type="button" className="pisti-link" onClick={() => setUseRecovery(!useRecovery)}>
                            {useRecovery ? "Use authenticator app" : "Use a recovery code"}
                        </button>
                    )}
                    <button type="button" className="pisti-link" onClick={() => setStep({ name: "start" })}>
                        Back
                    </button>
                </div>
            </Card>
        );

    if (step.name === "email-code")
        return (
            <Card title="Check your email" subtitle={<>Enter the code we sent to <strong>{step.identifier}</strong>.</>} className={className}>
                <form
                    className="pisti-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const code = String(new FormData(event.currentTarget).get("code")).trim();
                        void run(async () => handle(await client.signIn.verifyEmailCode(step.requestId, code)));
                    }}
                >
                    <fieldset disabled={pending}>
                        <CodeField />
                    </fieldset>
                    <Problem error={error} />
                    {notice && <p className="pisti-notice" role="status">{notice}</p>}
                    <button type="submit" disabled={pending}>
                        {pending ? "Verifying…" : "Continue"}
                    </button>
                </form>
                <div className="pisti-row">
                    <button
                        type="button"
                        className="pisti-link"
                        disabled={pending}
                        onClick={() =>
                            void run(async () => {
                                const sent = await client.signIn.sendEmailCode(step.identifier);
                                setStep({ ...step, requestId: sent.requestId });
                                setNotice("We sent a new code.");
                            })
                        }
                    >
                        Resend code
                    </button>
                    <button type="button" className="pisti-link" onClick={() => setStep({ name: "start" })}>
                        Use a different email
                    </button>
                </div>
            </Card>
        );

    if (step.name === "reset" || step.name === "reset-code")
        return (
            <Card
                title="Reset your password"
                subtitle={step.name === "reset" ? "We’ll email you a code." : <>Enter the code we sent to <strong>{step.identifier}</strong> and choose a new password.</>}
                className={className}
            >
                <form
                    className="pisti-form"
                    onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        if (step.name === "reset") {
                            const email = String(data.get("identifier")).trim();
                            void run(async () => {
                                const sent = await client.passwordReset.sendEmailCode(email);
                                setStep({ name: "reset-code", requestId: sent.requestId, identifier: email });
                            });
                        } else
                            void run(async () => {
                                const authenticatorCode = String(data.get("authenticatorCode") ?? "").trim();
                                await client.passwordReset.complete({
                                    requestId: step.requestId,
                                    code: String(data.get("code")).trim(),
                                    password: String(data.get("password")),
                                    ...(authenticatorCode ? { authenticatorCode } : {}),
                                });
                                setNotice("Password updated. Sign in with your new password.");
                                setStep({ name: "start" });
                            });
                    }}
                >
                    <fieldset disabled={pending}>
                        {step.name === "reset" ? (
                            <Field label="Email address" name="identifier" type="email" autoComplete="username" defaultValue={identifier} required autoFocus />
                        ) : (
                            <>
                                <CodeField label="Code from the email" />
                                <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={15} maxLength={128} required hint="At least 15 characters." />
                                <Field label="Authenticator code (only if you use one)" name="authenticatorCode" autoComplete="off" maxLength={64} />
                            </>
                        )}
                    </fieldset>
                    <Problem error={error} />
                    <button type="submit" disabled={pending}>
                        {pending ? "Working…" : step.name === "reset" ? "Send code" : "Update password"}
                    </button>
                </form>
                <div className="pisti-row">
                    <button type="button" className="pisti-link" onClick={() => setStep({ name: "start" })}>
                        Back to sign in
                    </button>
                </div>
            </Card>
        );

    if (step.name === "reactivate" || step.name === "reactivate-code")
        return (
            <Card
                title="Reactivate your account"
                subtitle={
                    step.name === "reactivate" ? (
                        "Deactivated accounts can be restored for 30 days. We’ll email you a code."
                    ) : (
                        <>
                            Enter the code we sent to <strong>{step.identifier}</strong>.
                        </>
                    )
                }
                className={className}
            >
                <form
                    className="pisti-form"
                    onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        if (step.name === "reactivate") {
                            const email = String(data.get("identifier")).trim();
                            void run(async () => {
                                const sent = await client.reactivation.sendEmailCode(email);
                                setStep({ name: "reactivate-code", requestId: sent.requestId, identifier: email });
                            });
                        } else
                            void run(async () => {
                                const authenticatorCode = String(data.get("authenticatorCode") ?? "").trim();
                                await client.reactivation.complete({
                                    requestId: step.requestId,
                                    code: String(data.get("code")).trim(),
                                    ...(authenticatorCode ? { authenticatorCode } : {}),
                                });
                                setNotice("Your account is active again. Sign in to continue.");
                                setStep({ name: "start" });
                            });
                    }}
                >
                    <fieldset disabled={pending}>
                        {step.name === "reactivate" ? (
                            <Field label="Email address" name="identifier" type="email" autoComplete="username" defaultValue={identifier} required autoFocus />
                        ) : (
                            <>
                                <CodeField label="Code from the email" />
                                <Field label="Authenticator code (only if you use one)" name="authenticatorCode" autoComplete="off" maxLength={64} />
                            </>
                        )}
                    </fieldset>
                    <Problem error={error} />
                    <button type="submit" disabled={pending}>
                        {pending ? "Working…" : step.name === "reactivate" ? "Send code" : "Reactivate account"}
                    </button>
                </form>
                <div className="pisti-row">
                    <button type="button" className="pisti-link" onClick={() => setStep({ name: "start" })}>
                        Back to sign in
                    </button>
                </div>
            </Card>
        );

    const emailOnly = !passwordEnabled || useCode;
    return (
        <Card title={`Sign in to ${environment.applicationName}`} subtitle="Welcome back! Please sign in to continue." footer={signUp} className={className}>
            {notice && <p className="pisti-notice" role="status">{notice}</p>}
            <form
                className="pisti-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const email = String(data.get("identifier")).trim();
                    setIdentifier(email);
                    setNotice(null);
                    void run(async () => {
                        if (emailOnly) {
                            const sent = await client.signIn.sendEmailCode(email);
                            setStep({ name: "email-code", requestId: sent.requestId, identifier: email });
                        } else await handle(await client.signIn.password(email, String(data.get("password"))));
                    });
                }}
            >
                <fieldset disabled={pending}>
                    <Field label="Email address" name="identifier" type="email" autoComplete="username" defaultValue={identifier} required autoFocus />
                    {!emailOnly && (
                        <Field
                            label="Password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            maxLength={128}
                            required
                            action={
                                <button
                                    type="button"
                                    className="pisti-link pisti-small"
                                    onClick={(event) => {
                                        const field = event.currentTarget.closest("form")?.querySelector<HTMLInputElement>('input[name="identifier"]');
                                        setIdentifier(field?.value.trim() ?? identifier);
                                        setError(null);
                                        setStep({ name: "reset", identifier: field?.value.trim() ?? identifier });
                                    }}
                                >
                                    Forgot password?
                                </button>
                            }
                        />
                    )}
                </fieldset>
                <Problem error={error} />
                <button type="submit" disabled={pending}>
                    {pending ? "Signing in…" : "Continue"}
                </button>
            </form>
            {passwordEnabled && codeEnabled && (
                <div className="pisti-row">
                    <button type="button" className="pisti-link" onClick={() => setUseCode(!useCode)}>
                        {useCode ? "Use your password instead" : "Email me a sign-in code instead"}
                    </button>
                </div>
            )}
            <div className="pisti-row">
                <button
                    type="button"
                    className="pisti-link pisti-small"
                    onClick={() => {
                        setError(null);
                        setNotice(null);
                        setStep({ name: "reactivate", identifier });
                    }}
                >
                    Reactivate a deactivated account
                </button>
            </div>
        </Card>
    );
}

/** A complete sign-up form: email verification by code, name and an optional password. */
export function SignUp({ forceRedirectUrl, fallbackRedirectUrl, signInUrl, className }: SignUpProps) {
    const client = usePisti();
    const inModal = useContext(ModalContext);
    const { isLoaded, isSignedIn } = useAuth();
    const { environment, error: loadError } = useEnvironment();
    const done = () => {
        if (inModal) {
            const options = client.getModalOptions();
            client.closeModal();
            if (options.forceRedirectUrl || options.fallbackRedirectUrl) client.redirectAfterSignUp(options);
        } else client.redirectAfterSignUp({ forceRedirectUrl, fallbackRedirectUrl });
    };
    const [request, setRequest] = useState<{ requestId: string; email: string } | null>(null);
    const [details, setDetails] = useState<{ firstName: string; lastName: string; password: string }>({
        firstName: "",
        lastName: "",
        password: "",
    });
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const arrival = useRef(false);
    useEffect(() => {
        if (!isLoaded || arrival.current) return;
        arrival.current = true;
        if (isSignedIn) done();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoaded, isSignedIn]);
    async function run(work: () => Promise<void>) {
        setPending(true);
        setError(null);
        try {
            await work();
        } catch (failure) {
            setError(failure instanceof PistiClientError && failure.code === "sign_up_disabled" ? "Sign-ups are closed for this app." : message(failure));
        } finally {
            setPending(false);
        }
    }
    if (!environment)
        return (
            <Card title="Create your account" className={className}>
                {loadError ? <Problem error={loadError} /> : <p className="pisti-muted" role="status">Loading…</p>}
            </Card>
        );
    const signIn = (
        <>
            Already have an account?{" "}
            <button
                type="button"
                className="pisti-link"
                onClick={() => {
                    const target = signInUrl ?? client.signInUrl;
                    if (inModal || !target) client.openSignIn(client.getModalOptions());
                    else client.navigate(target);
                }}
            >
                Sign in
            </button>
        </>
    );
    if (!environment.signUp.enabled)
        return (
            <Card title="Sign-ups are closed" subtitle="Ask the app’s owner for an invitation." footer={signIn} className={className}>
                <span />
            </Card>
        );
    if (request)
        return (
            <Card title="Verify your email" subtitle={<>Enter the code we sent to <strong>{request.email}</strong>.</>} footer={signIn} className={className}>
                <form
                    className="pisti-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const code = String(new FormData(event.currentTarget).get("code")).trim();
                        void run(async () => {
                            const result = await client.signUp.verify({
                                requestId: request.requestId,
                                code,
                                firstName: details.firstName,
                                lastName: details.lastName,
                                ...(details.password ? { password: details.password } : {}),
                            });
                            if (result.status === "complete") done();
                            else setError("Sign in to finish setting up two-step verification.");
                        });
                    }}
                >
                    <fieldset disabled={pending}>
                        <CodeField />
                    </fieldset>
                    <Problem error={error} />
                    <button type="submit" disabled={pending}>
                        {pending ? "Creating account…" : "Continue"}
                    </button>
                </form>
                <div className="pisti-row">
                    <button type="button" className="pisti-link" onClick={() => setRequest(null)}>
                        Use a different email
                    </button>
                </div>
            </Card>
        );
    return (
        <Card title="Create your account" subtitle={`Welcome! Fill in the details to get started with ${environment.applicationName}.`} footer={signIn} className={className}>
            <form
                className="pisti-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const email = String(data.get("email")).trim();
                    setDetails({
                        firstName: String(data.get("firstName") ?? "").trim(),
                        lastName: String(data.get("lastName") ?? "").trim(),
                        password: String(data.get("password") ?? ""),
                    });
                    void run(async () => {
                        const sent = await client.signUp.sendEmailCode(email);
                        setRequest({ requestId: sent.requestId, email });
                    });
                }}
            >
                <fieldset disabled={pending}>
                    <div className="pisti-pair">
                        <Field label="First name" name="firstName" autoComplete="given-name" maxLength={100} defaultValue={details.firstName} />
                        <Field label="Last name" name="lastName" autoComplete="family-name" maxLength={100} defaultValue={details.lastName} />
                    </div>
                    <Field label="Email address" name="email" type="email" autoComplete="email" required autoFocus />
                    {environment.signUp.password && (
                        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={15} maxLength={128} required hint="At least 15 characters." />
                    )}
                </fieldset>
                <Problem error={error} />
                <button type="submit" disabled={pending}>
                    {pending ? "Sending code…" : "Continue"}
                </button>
            </form>
        </Card>
    );
}
