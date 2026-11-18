#!/usr/bin/env node
// Pulls the public API contract from pisti-backend and generates the TypeScript the SDKs build on.
//
//   node scripts/contract.mjs pull    fetch the documents into contract/ and regenerate
//   node scripts/contract.mjs check   fail when the generated code was edited or the documents are behind
//
// PISTI_CONTRACT_REF picks the pisti-backend ref (default main). PISTI_CONTRACT_OFFLINE=1 makes
// `check` skip the fetch and compare only the generated code against the committed documents.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "pisti-paypiller/pisti-backend";
const ref = process.env.PISTI_CONTRACT_REF || "main";
const offline = process.env.PISTI_CONTRACT_OFFLINE === "1";
const cli = join(root, "node_modules", "openapi-typescript", "bin", "cli.js");

/** Each document, and the file generated from it in the package that reads it. */
const documents = [
    { name: "backend", output: "backend/src/generated/backend.ts" },
    { name: "frontend", output: "react/src/generated/frontend.ts" },
];

const documentPath = (name) => join(root, "contract", `${name}.json`);

function fetchDocument(name) {
    try {
        return execFileSync(
            "gh",
            [
                "api",
                `repos/${repository}/contents/openapi/${name}.json?ref=${encodeURIComponent(ref)}`,
                "-H",
                "Accept: application/vnd.github.raw",
            ],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
        );
    } catch (error) {
        const detail = String(error.stderr || error.message).trim();
        throw new Error(
            `Could not fetch openapi/${name}.json at ${repository}@${ref} with the gh CLI (${detail}). ` +
                "Sign in with `gh auth login`, or set PISTI_CONTRACT_OFFLINE=1 to skip the fetch in `contract:check`.",
        );
    }
}

/** Normalizes a fetched document to the committed form: parsed, two-space indented, LF, trailing newline. */
function normalize(text, name) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`openapi/${name}.json at ${ref} is not JSON.`);
    }
    if (typeof parsed.openapi !== "string" || typeof parsed.paths !== "object")
        throw new Error(`openapi/${name}.json at ${ref} is not an OpenAPI document.`);
    return JSON.stringify(parsed, null, 2) + "\n";
}

function generate(input, output) {
    mkdirSync(dirname(output), { recursive: true });
    execFileSync(process.execPath, [cli, input, "--empty-objects-unknown", "-o", output], {
        stdio: ["ignore", "ignore", "inherit"],
    });
    writeFileSync(output, readFileSync(output, "utf8").replace(/\r\n/g, "\n"));
}

function pull() {
    for (const { name, output } of documents) {
        writeFileSync(documentPath(name), normalize(fetchDocument(name), name));
        generate(documentPath(name), join(root, output));
        console.log(`contract/${name}.json (${repository}@${ref}) -> ${output}`);
    }
}

function check() {
    const failures = [];
    const temp = mkdtempSync(join(tmpdir(), "pisti-contract-"));
    try {
        for (const { name, output } of documents) {
            const committed = documentPath(name);
            const fresh = join(temp, `${name}.ts`);
            generate(committed, fresh);
            let current = null;
            try {
                current = readFileSync(join(root, output), "utf8");
            } catch {}
            if (current !== readFileSync(fresh, "utf8"))
                failures.push(`${output} does not match contract/${name}.json. Never edit it by hand; run npm run contract:pull.`);
            if (offline) continue;
            if (normalize(fetchDocument(name), name) !== readFileSync(committed, "utf8"))
                failures.push(`contract/${name}.json is behind ${repository}@${ref}. Run npm run contract:pull.`);
        }
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
    if (offline) console.warn("PISTI_CONTRACT_OFFLINE=1: skipped comparing contract/ with pisti-backend.");
    if (failures.length) {
        for (const failure of failures) console.error(failure);
        process.exit(1);
    }
    console.log(`Contract is current with ${offline ? "the committed documents" : `${repository}@${ref}`}.`);
}

const command = process.argv[2];
try {
    if (command === "pull") pull();
    else if (command === "check") check();
    else throw new Error("Usage: node scripts/contract.mjs pull|check");
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
