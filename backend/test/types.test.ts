// Compile-time checks of the public types. `npm run check` type-checks this file; Vitest runs it too.
import { describe, expectTypeOf, it } from "vitest";
import type {
    DeletedResource,
    Email,
    MutationOptions,
    OrganizationMembership,
    PistiClient,
    RequestOptions,
    SecretKey,
    Session,
    User,
    WebhookCatalogEntry,
    WebhookEvent,
    WebhookEventOf,
    WebhookEventType,
    WebhookTestData,
} from "../src/index.js";
import type { WebhookEvent as SubpathWebhookEvent } from "../src/webhooks.js";

describe("WebhookEvent", () => {
    it("narrows data by type", () => {
        const handle = (event: WebhookEvent) => {
            switch (event.type) {
                case "user.created":
                case "user.updated":
                    expectTypeOf(event.data).toEqualTypeOf<User>();
                    break;
                case "user.deleted":
                case "organization.deleted":
                case "organizationMembership.deleted":
                    expectTypeOf(event.data).toEqualTypeOf<DeletedResource>();
                    break;
                case "session.created":
                case "session.ended":
                    expectTypeOf(event.data).toEqualTypeOf<Session>();
                    break;
                case "organizationMembership.created":
                    expectTypeOf(event.data).toEqualTypeOf<OrganizationMembership>();
                    expectTypeOf(event.data.organizationId).toEqualTypeOf<string>();
                    break;
                case "apiKey.expiring":
                    expectTypeOf(event.data).toEqualTypeOf<SecretKey>();
                    break;
                case "email.created":
                    expectTypeOf(event.data).toEqualTypeOf<Email>();
                    break;
                case "endpoint.test":
                    expectTypeOf(event.data).toEqualTypeOf<WebhookTestData>();
                    break;
            }
        };
        expectTypeOf(handle).parameter(0).toEqualTypeOf<WebhookEvent>();
        expectTypeOf<WebhookEventOf<"user.created">["data"]>().toEqualTypeOf<User>();
        expectTypeOf<SubpathWebhookEvent>().toEqualTypeOf<WebhookEvent>();
    });

    it("covers the catalog and the test event", () => {
        expectTypeOf<WebhookEvent["type"]>().toEqualTypeOf<WebhookEventType | "endpoint.test">();
        expectTypeOf<"apiKey.expiring">().toExtend<WebhookEventType>();
        expectTypeOf<"email.created">().toExtend<WebhookEventType>();
        expectTypeOf<"endpoint.test">().not.toExtend<WebhookEventType>();
        expectTypeOf<WebhookCatalogEntry["type"]>().toEqualTypeOf<WebhookEventType>();
    });
});

describe("Request options", () => {
    it("take an idempotency key only on mutations", () => {
        expectTypeOf<PistiClient["users"]["createUser"]>().parameter(1).toEqualTypeOf<MutationOptions | undefined>();
        expectTypeOf<PistiClient["organizations"]["deleteOrganization"]>().parameter(1).toEqualTypeOf<MutationOptions | undefined>();
        expectTypeOf<PistiClient["users"]["getUser"]>().parameter(1).toEqualTypeOf<RequestOptions | undefined>();
        const reads = (pisti: PistiClient) => {
            // @ts-expect-error reads take no idempotency key
            void pisti.users.getUser("user_0Hk3pQ9xZb2", { idempotencyKey: "k" });
        };
        void reads;
    });
});
