import { useCallback, useId, useState, type FormEvent } from "react";
import { useAuth, useOrganizationList, usePisti } from "./context.js";
import {
    ActionNotice,
    ErrorNotice,
    Loading,
    useAction,
    useResource,
} from "./ui.js";

export function OrganizationSwitcher({
    className = "",
}: {
    className?: string;
}) {
    const organizations = useOrganizationList();
    const auth = useAuth();
    const load = useCallback(
        () => (auth.isSignedIn ? organizations.list() : Promise.resolve([])),
        [
            organizations,
            auth.isSignedIn,
            auth.userId,
            auth.sessionId,
            auth.user?.organizationId,
        ],
    );
    const query = useResource(load);
    const action = useAction();
    const id = useId();
    if (!auth.isSignedIn) return null;
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
                            organizations.setActive(event.target.value || null),
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
    const auth = useAuth();
    const action = useAction();
    const id = useId();
    if (!auth.isLoaded) return <Loading />;
    if (!auth.isSignedIn) return <p>Sign in to create an organization.</p>;
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        void action.run(async () => {
            const created = await organizations.create({
                name: String(fields.get("name")),
                slug: String(fields.get("slug")),
            });
            await organizations.setActive(created.id);
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

export function AcceptOrganizationInvitation({
    token,
    onAccepted,
    className = "",
}: {
    token: string;
    onAccepted?: () => void;
    className?: string;
}) {
    const organizations = useOrganizationList();
    const auth = useAuth();
    const pisti = usePisti();
    const action = useAction();
    if (!auth.isLoaded) return <Loading />;
    return (
        <section className={"pisti-ui " + className}>
            <h2>Join your organization</h2>
            <p className="pisti-muted">
                Sign in using the email address that received this invitation.
            </p>
            {auth.isSignedIn ? (
                <button
                    type="button"
                    disabled={action.isPending}
                    onClick={() =>
                        void action.run(async () => {
                            await organizations.acceptInvitation(token);
                            onAccepted?.();
                        }, "You have joined the organization.")
                    }
                >
                    {action.isPending ? "Joining…" : "Accept invitation"}
                </button>
            ) : (
                <button
                    type="button"
                    disabled={action.isPending}
                    onClick={() =>
                        pisti.redirectToSignIn()
                    }
                >
                    Sign in to continue
                </button>
            )}
            <ActionNotice action={action} />
        </section>
    );
}

export function OrganizationProfile({
    className = "",
}: {
    className?: string;
}) {
    const organizations = useOrganizationList();
    const auth = useAuth();
    const id = useId();
    const organizationId = auth.user?.organizationId;
    const canReadMembers = auth.has({
        permission: "organization.members.read",
    });
    const canManageMembers = auth.has({
        permission: "organization.members.write",
    });
    const canInvite = auth.has({
        permission: "organization.invitations.write",
    });
    const canUpdate = auth.has({ permission: "organization.write" });
    const load = useCallback(async () => {
        if (!organizationId) return null;
        const [list, members, roles, invitations] = await Promise.all([
            organizations.list(),
            canReadMembers
                ? organizations.members(organizationId)
                : Promise.resolve([]),
            canReadMembers
                ? organizations.roles(organizationId)
                : Promise.resolve([]),
            canInvite
                ? organizations.invitations(organizationId)
                : Promise.resolve([]),
        ]);
        return {
            organization: list.find((item) => item.id === organizationId),
            members,
            roles,
            invitations,
        };
    }, [
        organizations,
        organizationId,
        canReadMembers,
        canInvite,
        auth.userId,
        auth.sessionId,
        auth.user?.organizationRole,
    ]);
    const query = useResource(load);
    const action = useAction();
    if (!auth.isLoaded || (query.isLoading && !query.data)) return <Loading />;
    if (!auth.isSignedIn) return <p>Sign in to manage your organization.</p>;
    if (!organizationId)
        return <p>Select an organization to view its settings.</p>;
    if (!query.data?.organization)
        return (
            <ErrorNotice
                error={
                    query.error ?? new Error("The organization is unavailable.")
                }
                retry={query.reload}
            />
        );
    const { organization, roles, members, invitations } = query.data;
    const assignableRoles = roles.filter((role) =>
        role.permissions.every((permission) => auth.has({ permission })),
    );
    const defaultRole =
        assignableRoles.find((role) => role.key === "member")?.id ??
        assignableRoles[0]?.id;
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
                        void action.run(async () => {
                            await organizations.update(organizationId, {
                                name: String(fields.get("name")),
                                slug: String(fields.get("slug")),
                                expectedUpdatedAt: organization.updatedAt,
                                imageUrl: organization.imageUrl,
                            });
                            query.reload();
                        }, "Organization updated.");
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
            {canInvite && (
                <section className="pisti-section">
                    <h2>Invite a teammate</h2>
                    {defaultRole ? (
                        <form
                            className="pisti-form"
                            onSubmit={(event) => {
                                event.preventDefault();
                                const form = event.currentTarget;
                                const fields = new FormData(form);
                                void action.run(async () => {
                                    await organizations.invite(
                                        organizationId,
                                        String(fields.get("email")),
                                        String(fields.get("role")),
                                    );
                                    form.reset();
                                    query.reload();
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
                                                value={role.id}
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
                    <ul className="pisti-list">
                        {invitations.map((invitation) => (
                            <li key={invitation.id}>
                                <div>
                                    {invitation.email}
                                    <p className="pisti-muted">
                                        {invitation.status}
                                    </p>
                                </div>
                                {invitation.status === "pending" && (
                                    <button
                                        type="button"
                                        className="pisti-secondary"
                                        disabled={action.isPending}
                                        onClick={() =>
                                            void action.run(async () => {
                                                await organizations.revokeInvitation(
                                                    organizationId,
                                                    invitation.id,
                                                );
                                                query.reload();
                                            }, "Invitation revoked.")
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
                    {members.length === 0 && <p>No members found.</p>}
                    <ul className="pisti-list">
                        {members.map((member) => (
                            <li key={member.userId + ":" + member.roleId}>
                                <div>
                                    {member.email}
                                    <p className="pisti-muted">
                                        {member.roleKey}
                                    </p>
                                </div>
                                {canManageMembers &&
                                    member.userId !== auth.user?.id && (
                                        <div className="pisti-actions">
                                            <label
                                                className="pisti-sr-only"
                                                htmlFor={
                                                    id +
                                                    member.userId +
                                                    member.roleId
                                                }
                                            >
                                                Role for {member.email}
                                            </label>
                                            <select
                                                id={
                                                    id +
                                                    member.userId +
                                                    member.roleId
                                                }
                                                value={member.roleId}
                                                disabled={action.isPending}
                                                onChange={(event) =>
                                                    void action.run(
                                                        async () => {
                                                            await organizations.setMemberRole(
                                                                organizationId,
                                                                member.userId,
                                                                event.target
                                                                    .value,
                                                            );
                                                            query.reload();
                                                        },
                                                        "Member role updated.",
                                                    )
                                                }
                                            >
                                                {!assignableRoles.some(
                                                    (role) =>
                                                        role.id ===
                                                        member.roleId,
                                                ) && (
                                                    <option
                                                        value={member.roleId}
                                                    >
                                                        {member.roleKey}
                                                    </option>
                                                )}
                                                {assignableRoles.map((role) => (
                                                    <option
                                                        key={role.id}
                                                        value={role.id}
                                                    >
                                                        {role.name}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                type="button"
                                                className="pisti-secondary"
                                                disabled={action.isPending}
                                                onClick={() => {
                                                    if (
                                                        window.confirm(
                                                            "Remove " +
                                                                member.email +
                                                                " from this organization?",
                                                        )
                                                    )
                                                        void action.run(
                                                            async () => {
                                                                await organizations.removeMember(
                                                                    organizationId,
                                                                    member.userId,
                                                                );
                                                                query.reload();
                                                            },
                                                            "Member removed.",
                                                        );
                                                }}
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
                    If you are the final owner, make someone else an owner
                    before leaving. As the only member, you can simply leave.
                </p>
                <button
                    type="button"
                    className="pisti-danger"
                    disabled={action.isPending}
                    onClick={() => {
                        if (window.confirm("Leave " + organization.name + "?"))
                            void action.run(() =>
                                organizations.leave(organizationId),
                            );
                    }}
                >
                    Leave organization
                </button>
            </section>
            {auth.orgRole === "owner" && auth.orgId === organizationId && (
                <section className="pisti-section">
                    <h2>Delete organization</h2>
                    <p className="pisti-muted">
                        Removes every member and pending invitation. This can’t be undone.
                    </p>
                    <button
                        type="button"
                        className="pisti-danger"
                        disabled={action.isPending}
                        onClick={() => {
                            if (window.confirm("Delete " + organization.name + " for everyone?"))
                                void action.run(() => organizations.delete(organizationId));
                        }}
                    >
                        Delete organization
                    </button>
                </section>
            )}
        </section>
    );
}
