import { describe, expect, it } from "vitest";
import { rejectDataOnlyFunctions } from "../src/executor/data-only.js";
import { resolveRefs, processSpec, extractTags, extractServerBasePath } from "../src/spec.js";
import { emptyExecuteStats } from "../src/types.js";

describe("resolveRefs", () => {
  it("resolves simple $ref", () => {
    const spec = {
      components: {
        schemas: {
          Pet: { type: "object", properties: { name: { type: "string" } } },
        },
      },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
            },
          },
        },
      },
    };

    const result = resolveRefs(spec.paths["/pets"]!.get.responses, spec) as any;
    expect(result["200"].content["application/json"].schema.type).toBe("object");
    expect(result["200"].content["application/json"].schema.properties.name.type).toBe("string");
  });

  it("handles circular references", () => {
    const spec = {
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              child: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
    };

    const result = resolveRefs(spec.components.schemas.Node, spec) as any;
    expect(result.type).toBe("object");
    // First level resolves, second level detects the cycle
    expect(result.properties.child.type).toBe("object");
    expect(result.properties.child.properties.child.$circular).toBe("#/components/schemas/Node");
  });

  it("handles null and primitives", () => {
    expect(resolveRefs(null, {})).toBe(null);
    expect(resolveRefs(undefined, {})).toBe(undefined);
    expect(resolveRefs("hello", {})).toBe("hello");
    expect(resolveRefs(42, {})).toBe(42);
  });

  it("resolves arrays", () => {
    const spec = {
      components: { schemas: { Tag: { type: "string" } } },
    };
    const arr = [{ $ref: "#/components/schemas/Tag" }, "literal"];
    const result = resolveRefs(arr, spec) as any[];
    expect(result[0]).toEqual({ type: "string" });
    expect(result[1]).toBe("literal");
  });

  it("resolves the same $ref used in sibling positions", () => {
    const spec = {
      components: {
        schemas: {
          Pet: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    };

    const obj = {
      fieldA: { $ref: "#/components/schemas/Pet" },
      fieldB: { $ref: "#/components/schemas/Pet" },
    };

    const result = resolveRefs(obj, spec) as any;
    // Both should resolve fully — not mark the second as $circular
    expect(result.fieldA.type).toBe("object");
    expect(result.fieldA.properties.name.type).toBe("string");
    expect(result.fieldB.type).toBe("object");
    expect(result.fieldB.properties.name.type).toBe("string");
    expect(result.fieldB.$circular).toBeUndefined();
  });

  it("blocks __proto__ and constructor in $ref paths", () => {
    const spec = {
      components: { schemas: { Safe: { type: "string" } } },
    };

    // __proto__ in $ref path
    const r1 = resolveRefs({ $ref: "#/__proto__/polluted" }, spec) as any;
    expect(r1.$error).toBe("unsafe ref path");

    // constructor in $ref path
    const r2 = resolveRefs({ $ref: "#/constructor/prototype" }, spec) as any;
    expect(r2.$error).toBe("unsafe ref path");
  });

  it("skips __proto__ keys in objects", () => {
    const obj = { safe: "yes", __proto__: "polluted", constructor: "bad" };
    const result = resolveRefs(obj, {}) as any;
    expect(result.safe).toBe("yes");
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
  });

  it("respects maxDepth limit", () => {
    // Build a deep chain: A -> B -> C -> D -> ...
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      if (i < 9) {
        schemas[`S${i}`] = { $ref: `#/components/schemas/S${i + 1}` };
      } else {
        schemas[`S${i}`] = { type: "string" };
      }
    }
    const spec = { components: { schemas } };

    // With maxDepth=5, should hit limit before reaching S9
    const result = resolveRefs(
      { $ref: "#/components/schemas/S0" },
      spec,
      undefined,
      5,
    ) as any;
    expect(result.$circular).toBeDefined();
    expect(result.$reason).toBe("max depth exceeded");
  });
});

describe("extractServerBasePath", () => {
  it("extracts path from relative URL", () => {
    expect(extractServerBasePath({ servers: [{ url: "/api/v3" }] } as any)).toBe("/api/v3");
  });

  it("extracts path from full URL", () => {
    expect(extractServerBasePath({ servers: [{ url: "https://petstore.io/api/v3" }] } as any)).toBe("/api/v3");
  });

  it("returns empty for root URL", () => {
    expect(extractServerBasePath({ servers: [{ url: "https://api.example.com" }] } as any)).toBe("");
  });

  it("returns empty when no servers", () => {
    expect(extractServerBasePath({})).toBe("");
    expect(extractServerBasePath({ servers: [] } as any)).toBe("");
  });

  it("strips trailing slash", () => {
    expect(extractServerBasePath({ servers: [{ url: "/api/v3/" }] } as any)).toBe("/api/v3");
  });
});

describe("processSpec", () => {
  it("extracts operations with resolved refs", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      components: {
        schemas: {
          Pet: { type: "object", properties: { name: { type: "string" } } },
        },
      },
      paths: {
        "/pets": {
          get: {
            summary: "List pets",
            tags: ["pets"],
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
          },
          post: {
            summary: "Create pet",
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      },
    };

    const result = processSpec(spec);
    const pets = result.paths as any;
    expect(pets["/pets"].get.summary).toBe("List pets");
    expect(pets["/pets"].get.tags).toEqual(["pets"]);
    expect(pets["/pets"].post.summary).toBe("Create pet");
    // $ref should be resolved
    expect(pets["/pets"].post.requestBody.content["application/json"].schema.type).toBe("object");
  });

  it("prepends server base path to all path keys", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Petstore", version: "1.0.0" },
      servers: [{ url: "/api/v3" }],
      paths: {
        "/pet": { get: { summary: "Get pets" } },
        "/pet/{petId}": { get: { summary: "Get pet by ID" } },
      },
    };

    const result = processSpec(spec);
    const paths = result.paths as any;
    expect(paths["/api/v3/pet"]).toBeDefined();
    expect(paths["/api/v3/pet/{petId}"]).toBeDefined();
    expect(paths["/pet"]).toBeUndefined();
  });

  it("omits info, servers, and components", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "My API", version: "2.0.0" },
      servers: [{ url: "/api/v3" }],
      paths: {},
      components: { schemas: { Foo: { type: "object" } } },
    };

    const result = processSpec(spec);
    expect((result as any).info).toBeUndefined();
    expect((result as any).servers).toBeUndefined();
    expect((result as any).components).toBeUndefined();
  });

  it("skips non-HTTP method keys", () => {
    const spec = {
      paths: {
        "/test": {
          get: { summary: "Get" },
          parameters: [{ name: "shared" }],
          description: "path-level description",
        },
      },
    };

    const result = processSpec(spec);
    const test = (result.paths as any)["/test"];
    expect(test.get).toBeDefined();
    expect(test.parameters).toBeUndefined();
    expect(test.description).toBeUndefined();
  });

  it("shares acyclic component expansions across operations", () => {
    const spec = {
      components: {
        schemas: {
          Pet: { type: "object", properties: { name: { type: "string" } } },
        },
      },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
            },
          },
        },
        "/featured-pet": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
            },
          },
        },
      },
    };

    const paths = processSpec(spec).paths as any;
    const petsSchema = paths["/pets"].get.responses["200"].content["application/json"].schema;
    const featuredPetSchema = paths["/featured-pet"].get.responses["200"].content["application/json"].schema;

    expect(petsSchema.properties.name.type).toBe("string");
    expect(featuredPetSchema.properties.name.type).toBe("string");
    expect(petsSchema.$ref).toBeUndefined();
    expect(featuredPetSchema.$ref).toBeUndefined();
    expect(featuredPetSchema).toBe(petsSchema);
  });

  it("resolves mutually recursive component roots in each endpoint context", () => {
    const spec = {
      components: {
        schemas: {
          Parent: {
            type: "object",
            properties: {
              parentName: { type: "string" },
              child: { $ref: "#/components/schemas/Child" },
            },
          },
          Child: {
            type: "object",
            properties: {
              childAge: { type: "integer" },
              parent: { $ref: "#/components/schemas/Parent" },
            },
          },
        },
      },
      paths: {
        "/parent": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Parent" } } } },
            },
          },
        },
        "/child": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Child" } } } },
            },
          },
        },
      },
    };

    const paths = processSpec(spec).paths as any;
    const parentSchema = paths["/parent"].get.responses["200"].content["application/json"].schema;
    const childSchema = paths["/child"].get.responses["200"].content["application/json"].schema;

    expect(parentSchema.properties.parentName.type).toBe("string");
    expect(parentSchema.properties.child.properties.childAge.type).toBe("integer");
    expect(parentSchema.properties.child.properties.parent).toEqual({ $circular: "#/components/schemas/Parent" });

    expect(childSchema.properties.childAge.type).toBe("integer");
    expect(childSchema.properties.parent.properties.parentName.type).toBe("string");
    expect(childSchema.properties.parent.properties.child).toEqual({ $circular: "#/components/schemas/Child" });
  });

  it("keeps max-depth sentinels when a shallower endpoint has cached a ref", () => {
    const spec = {
      components: {
        schemas: {
          A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
          B: { type: "string" },
          C: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } },
        },
      },
      paths: {
        "/a": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } },
            },
          },
        },
        "/c": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/C" } } } },
            },
          },
        },
      },
    };

    const paths = processSpec(spec, 2).paths as any;
    const aSchema = paths["/a"].get.responses["200"].content["application/json"].schema;
    const cSchema = paths["/c"].get.responses["200"].content["application/json"].schema;

    expect(aSchema.properties.b.type).toBe("string");
    expect(cSchema.properties.a.properties.b).toEqual({
      $circular: "#/components/schemas/B",
      $reason: "max depth exceeded",
    });
  });

  it("keeps high-reuse processed specs below the data-only graph guard", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`field${index}`, { type: "string" }]),
    );
    const paths = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `/resources/${index}`,
        {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Resource" } } } },
            },
          },
        },
      ]),
    );
    const spec = {
      components: {
        schemas: {
          Resource: { type: "object", properties },
        },
      },
      paths,
    };

    const processed = processSpec(spec);

    expect(rejectDataOnlyFunctions({ spec: processed }, emptyExecuteStats())).toBeNull();
  });
});

describe("extractTags", () => {
  it("extracts tags sorted by frequency", () => {
    const spec = {
      paths: {
        "/a": { get: { tags: ["alpha", "beta"] }, post: { tags: ["alpha"] } },
        "/b": { get: { tags: ["beta"] } },
        "/c": { delete: { tags: ["gamma"] } },
      },
    };

    const tags = extractTags(spec);
    expect(tags[0]).toBe("alpha"); // 2 occurrences
    expect(tags[1]).toBe("beta");  // 2 occurrences
    expect(tags[2]).toBe("gamma"); // 1 occurrence
  });

  it("returns empty for spec without paths", () => {
    expect(extractTags({})).toEqual([]);
    expect(extractTags({ paths: {} })).toEqual([]);
  });
});
