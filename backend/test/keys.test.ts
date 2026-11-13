import { describe, expect, it } from "vitest";
import { parsePublishableKey, trustedUrl } from "../src/keys.js";
import { HOST_ORIGIN, publishableKey } from "./support.js";

describe("parsePublishableKey", () => {
    it("derives the environment's host and issuer", () => {
        const key = parsePublishableKey(publishableKey());

        expect(key.environment).toBe("test");
        expect(key.frontendApi.origin).toBe(HOST_ORIGIN);
        expect(key.issuer.href).toBe(`${HOST_ORIGIN}/`);
    });

    it.each([
        ["an unknown prefix", "sk_test_abc"],
        ["a missing payload", "pk_test_"],
        ["a payload without the terminator", `pk_test_${Buffer.from("http://localhost:3000").toString("base64url")}`],
        ["a payload with a path", `pk_test_${Buffer.from("http://localhost:3000/v1/fapi/fa_1$").toString("base64url")}`],
        ["a payload with a query", `pk_test_${Buffer.from("http://localhost:3000/?a=1$").toString("base64url")}`],
        ["a payload that is not a URL", `pk_test_${Buffer.from("not a url$").toString("base64url")}`],
    ])("rejects %s", (_, value) => {
        expect(() => parsePublishableKey(value)).toThrow();
    });

    it("rejects a live key that points at plain HTTP", () => {
        const encoded = Buffer.from("http://auth.example.com$").toString("base64url");
        expect(() => parsePublishableKey(`pk_live_${encoded}`)).toThrow(/HTTPS/);
    });
});

describe("trustedUrl", () => {
    it("accepts HTTPS everywhere and loopback HTTP in development", () => {
        expect(trustedUrl("https://api.example.com", false).origin).toBe("https://api.example.com");
        expect(trustedUrl("http://localhost:3000", true).origin).toBe("http://localhost:3000");
        expect(trustedUrl("http://app.localhost:3000", true).origin).toBe("http://app.localhost:3000");
    });

    it.each([
        ["loopback HTTP in production", "http://localhost:3000", false],
        ["public HTTP in development", "http://api.example.com", true],
        ["credentials", "https://user:pass@api.example.com", false],
        ["a query", "https://api.example.com/?a=1", false],
        ["a fragment", "https://api.example.com/#a", false],
    ])("rejects %s", (_, value, development) => {
        expect(() => trustedUrl(value, development)).toThrow();
    });
});
