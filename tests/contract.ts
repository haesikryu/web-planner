import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect } from "vitest";
import contract from "../contracts/openapi.json";

type ResponseSpec = { $ref?: string; content?: { "application/json"?: { schema: object } }; headers?: Record<string, { schema?: { pattern?: string } }> };
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const rewrite = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("#/components/schemas/", "#/$defs/"));
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export async function checked(promise: Promise<Response>, path: string, method: "get" | "post" | "patch" | "put"): Promise<Response> {
  const response = await promise;
  const paths = contract.paths as unknown as Record<string, Record<string, { responses: Record<string, ResponseSpec> }>>;
  let spec = paths[path][method].responses[String(response.status)];
  expect(spec, `${method} ${path}: undeclared status ${response.status}`).toBeDefined();
  if (spec.$ref) spec = contract.components.responses[spec.$ref.split("/").at(-1) as keyof typeof contract.components.responses] as ResponseSpec;
  const schema = spec.content?.["application/json"]?.schema;
  if (schema) {
    const key = `${path}:${method}:${response.status}`;
    let validate = validators.get(key);
    if (!validate) { validate = ajv.compile({ ...rewrite(schema), $defs: rewrite(contract.components.schemas) }); validators.set(key, validate); }
    expect(validate(await response.clone().json()), JSON.stringify(validate.errors)).toBe(true);
  }
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (spec.headers?.ETag) expect(response.headers.get("etag")).toMatch(new RegExp(spec.headers.ETag.schema?.pattern ?? '^"v[1-9][0-9]*"$', "u"));
  return response;
}
