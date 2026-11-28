import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { PistiClientError } from "./client.js";
import { useAuth, useMe, useOrganizationList, useOrganizationSettings, usePisti } from "./context.js";
import { readAll } from "./resources.js";
import {
    ActionNotice,
    ConfirmDialog,
    ErrorNotice,
    Loading,
    useAction,
    useResource,
} from "./ui.js";

/**
 * Says what a failed organization request means. An organization the user is not a member of answers `404` (it is not
 * told apart from one that does not exist), and an action the member's role does not allow answers `403`.
 */
export function describeOrganizationError(error: unknown): Error {
    if (error instanceof PistiClientError) {
        if (error.status === 404)
            return new PistiClientError("This organization isn’t available: it was deleted, or you are no longer a member.", 404, error.code);
        if (error.status === 403 && (!error.code || error.code === "forbidden"))
            return new PistiClientError("Your role in this organization doesn’t allow that.", 403, error.code);
    }
    return error instanceof Error ? error : new Error("The request could not be completed.");
}

/** Runs an organization request, turning 404 and 403 into messages the user can act on. */
async function organizationRequest<T>(task: () => Promise<T>): Promise<T> {
    try {
        return await task();
    } catch (error) {
        throw describeOrganizationError(error);
    }
}

/** Reads a list the member may not be allowed to see: `null` on 403. */
async function ifPermitted<T>(task: () => Promise<T>): Promise<T | null> {
    try {
        return await task();
    } catch (error) {
        if (error instanceof PistiClientError && error.status === 403 && error.code !== "organizations_disabled") return null;
        throw error;
    }
}

export function OrganizationSwitcher({
    className = "",
}: {
    className?: string;
}) {
    const me = useMe();
    const pisti = usePisti();
    const auth = useAuth();
    const load = useCallback(
        async () => (auth.isSignedIn ? (await readAll(me.getOrganizationMemberships)).map((membership) => membership.organization) : []),
        [
            me,
            auth.isSignedIn,
            auth.userId,
            auth.sessionId,
            auth.user?.organizationId,
        ],
    );
    const query = useResource(load);
    const action = useAction();
    const id = useId();
    const settings = useOrganizationSettings();
    if (!auth.isSignedIn || !settings.enabled) return null;
    return (
        <div className={"pisti-ui " + className}>
            <label htmlFor={id}>
                Organization
                <select
                    id={id}
                    value={auth.user?.organizationId ?? ""}
                    disabled={query.isLoading || action.isPending}
                    onChange={(event) =>
                        void action.run(() =>
                            pisti.setActiveOrganization(event.target.value || null),
                        )
                    }
                >
                    <option value="">Personal account</option>
                    {query.data?.map((organization) => (
                        <option key={organization.id} value={organization.id}>
                            {organization.name}
                        </option>
                    ))}
                </select>
            </label>
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
        </div>
    );
}

export function CreateOrganization({
    onCreated,
    className = "",
}: {
    onCreated?: (id: string) => void;
    className?: string;
}) {
    const organizations = useOrganizationList();
    const pisti = usePisti();
    const auth = useAuth();
    const action = useAction();
    const id = useId();
    const settings = useOrganizationSettings();
    if (!auth.isLoaded || !settings.isLoaded) return <Loading />;
    if (!settings.enabled) return null;
    if (!auth.isSignedIn) return <p>Sign in to create an organization.</p>;
    if (!settings.allowUserCreation) return <p>Organizations are created for you by this application.</p>;
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        void action.run(async () => {
            const created = await organizations.create({
                name: String(fields.get("name")),
                slug: String(fields.get("slug")),
            });
            await pisti.setActiveOrganization(created.id);
            form.reset();
            onCreated?.(created.id);
        }, "Your organization has been created.");
    };
    return (
        <section className={"pisti-ui " + className}>
            <h2>Create an organization</h2>
            <form className="pisti-form" onSubmit={submit}>
                <fieldset disabled={action.isPending}>
                    <label htmlFor={id + "-name"}>
                        Organization name
                        <input
                            id={id + "-name"}
                            name="name"
                            required
                            maxLength={100}
                            autoComplete="organization"
                        />
                    </label>
                    <label htmlFor={id + "-slug"}>
                        Organization slug
                        <input
                            id={id + "-slug"}
                            name="slug"
                            pattern="[a-z0-9]+(-[a-z0-9]+)*"
                            maxLength={100}
                            required
                        />
                    </label>
                    <p className="pisti-muted">
                        Use lowercase letters, numbers and hyphens for the slug.
                    </p>
                    <button type="submit">
                        {action.isPending ? "Creating…" : "Create organization"}
                    </button>
                </fieldset>
                <ActionNotice action={action} />
            </form>
        </section>
    );
}

/** The signed-in user's pending organization invitations (to their verified addresses), to accept by ID. Accepting
 * one joins the organization and makes it the session's active organization. */
export function OrganizationInvitations({
    onAccepted,
    className = "",
}: {
    onAccepted?: (organizationId: string) => void;
    className?: string;
}) {
    const me = useMe();
    const auth = useAuth();
    const action = useAction();
    const settings = useOrganizationSettings();
    const load = useCallback(
        () => (auth.isSignedIn ? readAll(me.getOrganizationInvitations) : Promise.resolve([])),
        [me, auth.isSignedIn, auth.sessionId],
    );
    const query = useResource(load);
    if (!auth.isLoaded || !settings.isLoaded) return <Loading />;
    if (!settings.enabled || !auth.isSignedIn) return null;
    return (
        <section className={"pisti-ui " + className}>
            <h2>Invitations</h2>
            {query.isLoading && <Loading />}
            <ErrorNotice error={query.error} retry={query.reload} />
            <ActionNotice action={action} />
            {query.data?.length === 0 && <p>You have no pending invitations.</p>}
            <ul className="pisti-list">
                {query.data?.map((invitation) => (
                    <li key={invitation.id}>
                        <div>
                            <strong>{invitation.publicOrganizationData.name}</strong>
                            <p className="pisti-muted">
                                {invitation.roleName} · sent to {invitation.emailAddress}
                            </p>
                        </div>
                        <button
                            type="button"
                            disabled={action.isPending}
                            onClick={() =>
                                void action.run(async () => {
                                    await organizationRequest(() => me.acceptOrganizationInvitation(invitation.id));
                                    query.reload();
                                    onAccepted?.(invitation.publicOrganizationData.id);
                                }, "You have joined " + invitation.publicOrganizationData.name + ".")
                            }
                        >
                            Accept
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

export function OrganizationProfile({
    className = "",
}: {
    className?: string;
}) {
    const organizations = useOrganizationList();
    const me = useMe();
    const pisti = usePisti();
    const auth = useAuth();
    const id = useId();
    const organizationId = auth.user?.organizationId;
    const settings = useOrganizationSettings();
    const canReadMembers = auth.has({
        permission: "org:sys_memberships:read",
    });
    const canManageMembers = auth.has({
        permission: "org:sys_memberships:manage",
    });
    const canUpdate = auth.has({ permission: "org:sys_profile:manage" });
    const canDelete = auth.has({ permission: "org:sys_profile:delete" });
    const load = useCallback(async () => {
        if (!organizationId || !settings.enabled) return null;
        // The token's permissions decide what to ask for; the server still decides, so a 403 hides that part.
        // The roles come from the server: the environment's roles this member may give others.
        const [organization, members, roles, invitations] = await Promise.all([
            organizationRequest(() => organizations.get(organizationId)),
            canReadMembers ? ifPermitted(() => readAll((page) => organizations.getMemberships(organizationId, page))) : null,
            canManageMembers ? ifPermitted(() => organizations.getRoles(organizationId)) : null,
            canManageMembers ? ifPermitted(() => readAll((page) => organizations.getInvitations(organizationId, page))) : null,
        ]);
        return { organization, members, roles: roles ?? [], invitations };
    }, [
        organizations,
        organizationId,
        settings.enabled,
        canReadMembers,
        canManageMembers,
        auth.userId,
        auth.sessionId,
        auth.user?.organizationRole,
    ]);
    const query = useResource(load);
    const action = useAction();
    const [confirming, setConfirming] = useState<
        { kind: "remove"; userId: string; email: string } | { kind: "leave" } | { kind: "delete" } | null
    >(null);
    // Memberships change elsewhere (a member leaves, an admin removes you): read them again when the page regains focus.
    const reload = query.reload;
    useEffect(() => {
        const refresh = () => {
            if (document.visibilityState === "visible") reload();
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [reload]);
    if (!auth.isLoaded || !settings.isLoaded || (query.isLoading && !query.data)) return <Loading />;
    if (!settings.enabled) return null;
    if (!auth.isSignedIn) return <p>Sign in to manage your organization.</p>;
    if (!organizationId)
        return <p>Select an organization to view its settings.</p>;
    if (!query.data?.organization) {
        const missing = query.error instanceof PistiClientError && query.error.status === 404;
        return (
            <section className={"pisti-ui " + className}>
                <ErrorNotice error={query.error ?? new Error("The organization is unavailable.")} {...(missing ? {} : { retry: query.reload })} />
                {missing && (
                    <button type="button" className="pisti-secondary" onClick={() => void pisti.setActiveOrganization(null)}>
                        Switch to your personal account
                    </button>
                )}
            </section>
        );
    }
    const { organization, roles: assignableRoles, members, invitations } = query.data;
    // Every organization action reports 404 and 403 the same way, and reloads so a lost membership shows at once.
    const run = (task: () => Promise<unknown>, message: string) =>
        void action.run(async () => {
            try {
                await organizationRequest(task);
            } finally {
                query.reload();
            }
        }, message);
    // Only roles the server says this member may give: the environment's default role may not be one of them.
    const defaultRole =
        assignableRoles.find((role) => role.key === "org:member")?.key ??
        assignableRoles[0]?.key;
    return (
        <section className={"pisti-ui " + className}>
            <h1>{organization.name}</h1>
            <ActionNotice action={action} />
            <ErrorNotice error={query.error} retry={query.reload} />
            {canUpdate && (
                <form
                    className="pisti-form"
                    key={organization.updatedAt}
                    onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const fields = new FormData(form);
                        run(
                            () =>
                                organizations.update(organizationId, {
                                    name: String(fields.get("name")),
                                    slug: String(fields.get("slug")),
                                    expectedUpdatedAt: organization.updatedAt,
                                }),
                            "Organization updated.",
                        );
                    }}
                >
                    <fieldset disabled={action.isPending}>
                        <legend>Organization profile</legend>
                        <label htmlFor={id + "-name"}>
                            Name
                            <input
                                id={id + "-name"}
                                name="name"
                                defaultValue={organization.name}
                                maxLength={100}
                                required
                            />
                        </label>
                        <label htmlFor={id + "-slug"}>
                            Slug
                            <input
                                id={id + "-slug"}
                                name="slug"
                                defaultValue={organization.slug}
                                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                                maxLength={100}
                                required
                            />
                        </label>
                        <button type="submit">Save organization</button>
                    </fieldset>
                </form>
            )}
            {canManageMembers && (
                <section className="pisti-section">
                    <h2>Invite a teammate</h2>
                    {assignableRoles.length > 0 ? (
                        <form
                            className="pisti-form"
                            onSubmit={(event) => {
                                event.preventDefault();
                                const form = event.currentTarget;
                                const fields = new FormData(form);
                                run(async () => {
                                    await organizations.inviteMember(organizationId, {
                                        emailAddress: String(fields.get("email")),
                                        role: String(fields.get("role")),
                                    });
                                    form.reset();
                                }, "Invitation queued for delivery.");
                            }}
                        >
                            <fieldset disabled={action.isPending}>
                                <label htmlFor={id + "-invite"}>
                                    Email address
                                    <input
                                        id={id + "-invite"}
                                        name="email"
                                        type="email"
                                        maxLength={254}
                                        required
                                    />
                                </label>
                                <label htmlFor={id + "-role"}>
                                    Role
                                    <select
                                        id={id + "-role"}
                                        name="role"
                                        defaultValue={defaultRole}
                                    >
                                        {assignableRoles.map((role) => (
                                            <option
                                                key={role.id}
                                                value={role.key}
                                            >
                                                {role.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <button type="submit">Send invitation</button>
                            </fieldset>
                        </form>
                    ) : (
                        <p>No roles are available for you to assign.</p>
                    )}
                    {invitations === null && <p className="pisti-muted">Your role doesn’t allow seeing invitations.</p>}
                    <ul className="pisti-list">
                        {invitations?.map((invitation) => (
                            <li key={invitation.id}>
                                <div>
                                    {invitation.email}
                                    <p className="pisti-muted">
                                        {invitation.roleName} · {invitation.status}
                                    </p>
                                </div>
                                {invitation.status === "pending" && (
                                    <button
                                        type="button"
                                        className="pisti-secondary"
                                        disabled={action.isPending}
                                        onClick={() =>
                                            run(() => organizations.revokeInvitation(organizationId, invitation.id), "Invitation revoked.")
                                        }
                                    >
                                        Revoke invitation
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {canReadMembers && (
                <section className="pisti-section">
                    <h2>Members</h2>
                    {members === null && <p className="pisti-muted">Your role doesn’t allow seeing members.</p>}
                    {members?.length === 0 && <p>No members found.</p>}
                    <ul className="pisti-list">
                        {members?.map((member) => (
                            <li key={member.id}>
                                <div>
                                    {member.email}
                                    <p className="pisti-muted">
                                        {member.roleName}
                                    </p>
                                </div>
                                {canManageMembers &&
                                    member.userId !== auth.user?.id && (
                                        <div className="pisti-actions">
                                            <label
                                                className="pisti-sr-only"
                                                htmlFor={id + member.id}
                                            >
                                                Role for {member.email}
                                            </label>
                                            <select
                                                id={id + member.id}
                                                value={member.role}
                                                disabled={action.isPending}
                                                onChange={(event) =>
                                                    run(
                                                        () => organizations.updateMember(organizationId, member.userId, { role: event.target.value }),
                                                        "Member role updated.",
                                                    )
                                                }
                                            >
                                                {!assignableRoles.some(
                                                    (role) =>
                                                        role.key ===
                                                        member.role,
                                                ) && (
                                                    <option
                                                        value={member.role}
                                                    >
                                                        {member.roleName}
                                                    </option>
                                                )}
                                                {assignableRoles.map((role) => (
                                                    <option
                                                        key={role.id}
                                                        value={role.key}
                                                    >
                                                        {role.name}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                type="button"
                                                className="pisti-secondary"
                                                disabled={action.isPending}
                                                onClick={() => setConfirming({ kind: "remove", userId: member.userId, email: member.email ?? member.userId })}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            <section className="pisti-section">
                <h2>Leave organization</h2>
                <p className="pisti-muted">
                    If you are the final admin, make someone else an admin
                    before leaving. As the only member, you can simply leave.
                </p>
                <button
                    type="button"
                    className="pisti-danger"
                    disabled={action.isPending}
                    onClick={() => setConfirming({ kind: "leave" })}
                >
                    Leave organization
                </button>
            </section>
            {canDelete && auth.orgId === organizationId && (
                <section className="pisti-section">
                    <h2>Delete organization</h2>
                    <p className="pisti-muted">
                        Removes every member and pending invitation. This can’t be undone.
                    </p>
                    <button
                        type="button"
                        className="pisti-danger"
                        disabled={action.isPending}
                        onClick={() => setConfirming({ kind: "delete" })}
                    >
                        Delete organization
                    </button>
                </section>
            )}
            <ConfirmDialog
                open={confirming !== null}
                danger
                title={
                    confirming?.kind === "remove"
                        ? "Remove member"
                        : confirming?.kind === "leave"
                          ? "Leave " + organization.name
                          : "Delete " + organization.name
                }
                description={
                    confirming?.kind === "remove"
                        ? <>Remove {confirming.email} from {organization.name}? They lose access at once.</>
                        : confirming?.kind === "leave"
                          ? "You lose access to this organization until someone invites you again."
                          : "This removes every member and pending invitation, for everyone. It can’t be undone."
                }
                confirmLabel={confirming?.kind === "remove" ? "Remove member" : confirming?.kind === "leave" ? "Leave organization" : "Delete organization"}
                confirmationText={confirming?.kind === "delete" ? organization.name : undefined}
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                    const chosen = confirming;
                    setConfirming(null);
                    if (chosen?.kind === "remove")
                        run(() => organizations.removeMember(organizationId, chosen.userId), "Member removed.");
                    else if (chosen?.kind === "leave")
                        run(() => me.leaveOrganization(organizationId), "You left " + organization.name + ".");
                    else if (chosen?.kind === "delete")
                        run(() => organizations.destroy(organizationId), organization.name + " was deleted.");
                }}
            />
        </section>
    );
}
