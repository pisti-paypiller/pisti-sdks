import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { authObject, type SessionClaims } from "@pisti-paypiller/backend";
import { requireAuth } from "../src/index.js";

const claims = (fva: [number, number]): SessionClaims => ({
    sub: "user_1",
    sid: "sess_1",
    iss: "https://auth.example.com/",
    aud: "pisti:session",
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
    instance_id: "ins_1",
    fid: "fapi_1",
    fva,
});

/** Runs requireAuth against a request already authenticated with the given factor ages. */
function run(options: Parameters<typeof requireAuth>[0], fva: [number, number]) {
    const req = { auth: authObject(claims(fva), "token"), path: "/api/payouts", method: "POST", accepts: () => "json" } as unknown as Request;
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
        setHeader: vi.fn(),
        status(code: number) {
            sent.status = code;
            return this;
        },
        type() {
            return this;
        },
        json(body: Record<string, unknown>) {
            sent.body = body;
            return this;
        },
    } as unknown as Response;
    const next = vi.fn();
    requireAuth(options)(req, res, next);
    return { sent, next };
}

describe("requireAuth reverification", () => {
    it("answers the Frontend API's session_reverification_required problem with the requirement", () => {
        const { sent, next } = run({ reverification: "strict_mfa" }, [30, 30]);

        expect(next).not.toHaveBeenCalled();
        expect(sent.status).toBe(403);
        expect(sent.body).toMatchObject({
            status: 403,
            code: "session_reverification_required",
            reverification: { level: "multi_factor", afterMinutes: 10 },
        });
    });

    it("reports a first-factor requirement as first_factor", () => {
        const { sent } = run({ reverification: { level: "first_factor", afterMinutes: 5 } }, [9, -1]);
        expect(sent.body?.reverification).toEqual({ level: "first_factor", afterMinutes: 5 });
    });

    it("lets a recently verified session through", () => {
        const { sent, next } = run({ reverification: "strict" }, [1, 1]);
        expect(next).toHaveBeenCalledOnce();
        expect(sent.status).toBeUndefined();
    });

    it("keeps permission failures as forbidden", () => {
        const { sent } = run({ permission: "org:invoices:create" }, [1, 1]);
        expect(sent.body).toMatchObject({ code: "forbidden" });
        expect(sent.body?.reverification).toBeUndefined();
    });
});
