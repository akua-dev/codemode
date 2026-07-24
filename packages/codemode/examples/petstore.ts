/**
 * Petstore Demo — see CodeMode in action.
 *
 * Fetches the real Swagger Petstore OpenAPI 3.x spec, then uses a small
 * Hono mock to serve the API in-process (no network needed for requests).
 *
 * Run:
 *   pnpm tsx examples/petstore.ts
 *   # or: task example
 */

import { CodeMode } from "@robinbraemer/codemode";
import { Hono } from "hono";

// ── Petstore mock (in-process, no network hop) ─────────────────────

const pets = new Map<number, Record<string, unknown>>([
  [1, { id: 1, name: "Rex", status: "available", category: { id: 1, name: "Dogs" }, photoUrls: [], tags: [{ id: 1, name: "friendly" }] }],
  [2, { id: 2, name: "Whiskers", status: "available", category: { id: 2, name: "Cats" }, photoUrls: [], tags: [] }],
  [3, { id: 3, name: "Bubbles", status: "sold", category: { id: 3, name: "Fish" }, photoUrls: [], tags: [] }],
]);
let nextId = 100;

const app = new Hono();

app.get("/api/v3/pet/findByStatus", (c) => {
  const status = c.req.query("status") ?? "available";
  const results = [...pets.values()].filter((p) => p.status === status);
  return c.json(results);
});

app.get("/api/v3/pet/:petId", (c) => {
  const pet = pets.get(Number(c.req.param("petId")));
  return pet ? c.json(pet) : c.json({ message: "Pet not found" }, 404);
});

app.post("/api/v3/pet", async (c) => {
  const body = await c.req.json();
  const id = body.id ?? nextId++;
  const pet = { id, ...body };
  pets.set(id, pet);
  return c.json(pet, 201);
});

app.get("/api/v3/store/inventory", (c) => {
  const counts: Record<string, number> = {};
  for (const pet of pets.values()) {
    const s = pet.status as string;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return c.json(counts);
});

// ── Fetch real OpenAPI spec ─────────────────────────────────────────

const SPEC_URL = "https://petstore3.swagger.io/api/v3/openapi.json";

console.log("Fetching Petstore OpenAPI spec...");
const spec = await fetch(SPEC_URL).then((r) => r.json());
console.log("Got spec:", spec.info.title, spec.info.version);

// ── Create CodeMode instance ────────────────────────────────────────

const codemode = new CodeMode({
  spec,
  request: app.request.bind(app), // in-process Hono handler
  baseUrl: "http://localhost",
  namespace: "petstore",
});

// ── Helpers ─────────────────────────────────────────────────────────

function step(label: string, result: { content: { text: string }[]; isError?: boolean }) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  if (result.isError) {
    console.log("ERROR:", result.content[0]!.text);
  } else {
    console.log(result.content[0]!.text);
  }
}

// ── Demo steps ──────────────────────────────────────────────────────

// 1. Search: API overview
step(
  "Search: API overview",
  await codemode.search(`async () => ({
    endpointCount: Object.keys(spec.paths).length,
    endpoints: Object.keys(spec.paths),
  })`),
);

// 2. Search: Find pet endpoints
step(
  "Search: Pet endpoints",
  await codemode.search(`async () => {
    return Object.entries(spec.paths)
      .filter(([p]) => p.startsWith('/api/v3/pet'))
      .flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([m]) => ['get','post','put','delete'].includes(m))
          .map(([method, op]) => ({
            method: method.toUpperCase(),
            path,
            summary: op.summary,
          }))
      );
  }`),
);

// 3. Search: Inspect Pet schema
step(
  "Search: Pet schema",
  await codemode.search(`async () => ({
    getPet: spec.paths['/api/v3/pet/{petId}']?.get?.responses,
    createPet: spec.paths['/api/v3/pet']?.post?.requestBody,
  })`),
);

// 4. Execute: Find available pets
step(
  "Execute: Find available pets",
  await codemode.execute(`async () => {
    const res = await petstore.request({
      method: "GET",
      path: "/api/v3/pet/findByStatus",
      query: { status: "available" },
    });
    return { status: res.status, pets: res.body };
  }`),
);

// 5. Execute: Create a pet, then retrieve it
step(
  "Execute: Create + fetch a pet",
  await codemode.execute(`async () => {
    const created = await petstore.request({
      method: "POST",
      path: "/api/v3/pet",
      body: {
        name: "Buddy",
        status: "available",
        category: { id: 1, name: "Dogs" },
        photoUrls: ["https://example.com/buddy.jpg"],
        tags: [{ id: 1, name: "good-boy" }],
      },
    });

    const fetched = await petstore.request({
      method: "GET",
      path: "/api/v3/pet/" + created.body.id,
    });

    return {
      created: { status: created.status, pet: created.body },
      fetched: { status: fetched.status, pet: fetched.body },
    };
  }`),
);

// 6. Execute: Store inventory
step(
  "Execute: Store inventory",
  await codemode.execute(`async () => {
    const res = await petstore.request({
      method: "GET",
      path: "/api/v3/store/inventory",
    });
    return res.body;
  }`),
);

codemode.dispose();
console.log("\nDone!");
