// Port of internal/lsp/adapters/{markdown,terraform}_test.go. httptest servers become Bun.serve.
import { afterEach, describe, expect, test } from "bun:test";
import { newJSONAdapter } from "../../../src/lsp/adapters/json.ts";
import {
  marksmanRecommendedVersion,
  marksmanRepositoryURL,
  newMarksmanAdapter,
  resolveMarksmanRuntimeDependency,
} from "../../../src/lsp/adapters/markdown.ts";
import {
  newTerraformLSAdapter,
  resolveTerraformLSRuntimeDependency,
  terraformLSRecommendedVersion,
  terraformLSReleasesBase,
} from "../../../src/lsp/adapters/terraform.ts";
import {
  codeCapabilityProfile,
  documentConfigCapabilityProfile,
} from "../../../src/lsp/capabilities.ts";
import { Registry } from "../../../src/lsp/registry.ts";
import type { Language, LanguageAdapter, RuntimeDependency } from "../../../src/lsp/types.ts";

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(fetch: (req: Request) => Response): { url: string; hits: string[] } {
  const hits: string[] = [];
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      hits.push(new URL(req.url).pathname);
      return fetch(req);
    },
  });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}`, hits };
}

function languageOf(a: LanguageAdapter): Language {
  return {
    id: a.id(),
    name: a.name(),
    extensions: a.extensions(),
    matchers: a.pathMatchers?.() ?? [],
    lazyStart: a.lazyStart?.() ?? false,
  };
}

describe("marksman", () => {
  const a = newMarksmanAdapter();
  const dep = (platform: string): RuntimeDependency => {
    const d = a.runtimeDeps().find((x) => x.platform_id === platform);
    if (!d) throw new Error(`missing ${platform}`);
    return d;
  };

  test("contracts", () => {
    expect(a.id()).toBe("markdown");
    expect(a.name()).toBe("Markdown");
    expect(a.extensions()).toEqual([".md", ".markdown"]);
    expect(a.lazyStart()).toBe(true);
    expect(a.capabilityProfile()).toEqual(documentConfigCapabilityProfile());
    expect(a.defaultArgs()).toEqual(["server"]);
    const b = a.binaries();
    expect(b).toHaveLength(1);
    expect(b[0]?.name).toBe("marksman");
    expect(b[0]?.args).toEqual(["server"]);
    expect(b[0]?.check_args).toEqual(["--version"]);
    expect(a.supportsImplementation()).toBe(false);
    expect(typeof a.resolveRuntimeDependency).toBe("function");
  });

  test("markdown routing", () => {
    const r = new Registry([languageOf(a)]);
    for (const p of ["README.md", "docs/guide.MD", "docs/reference.markdown"]) {
      expect(r.forPath(p)?.id).toBe("markdown");
    }
    for (const p of [
      "component.mdx",
      "docs/readme.txt",
      ".knowns/docs/readme.md",
      "project\\.knowns\\docs\\readme.md",
    ]) {
      expect(r.forPath(p)).toBeUndefined();
    }
    expect(r.language("markdown")?.lazyStart).toBe(true);
  });

  test("recommended release metadata", () => {
    const want: Record<string, string> = {
      "darwin-arm64": "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
      "darwin-amd64": "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
      "linux-arm64": "db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb",
      "linux-amd64": "be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087",
      "windows-amd64": "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705",
    };
    const deps = a.runtimeDeps();
    expect(deps).toHaveLength(5);
    for (const d of deps) {
      const sha = want[d.platform_id ?? ""];
      expect(sha).toBeDefined();
      expect(d.version).toBe(marksmanRecommendedVersion);
      expect(d.recommended_version).toBe(marksmanRecommendedVersion);
      expect(d.source).toBe("release");
      expect(d.archive_type).toBe("binary");
      expect(d.binary_name).toBe("marksman");
      expect(
        d.url?.startsWith(
          `${marksmanRepositoryURL}/releases/download/${marksmanRecommendedVersion}/`,
        ),
      ).toBe(true);
      expect(d.sha256).toBe(sha);
      expect(d.recommended_integrity).toBe(`sha256:${sha}`);
    }
  });

  test("recommended resolution is pinned and offline", async () => {
    const d = dep("linux-amd64");
    const res = await resolveMarksmanRuntimeDependency(undefined, undefined, "", d, {});
    expect(res.resolved_version).toBe(marksmanRecommendedVersion);
    expect(res.dependency.url).toBe(d.url);
    expect(res.integrity).toBe(d.recommended_integrity);
  });

  const resolvedVersion = "2026-07-20";
  const resolvedSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  for (const [name, selector, wantPath] of [
    ["latest", { latest: true }, "/latest"],
    ["tag", { version: resolvedVersion }, `/tags/${resolvedVersion}`],
  ] as const) {
    test(`latest and tag: ${name}`, async () => {
      const srv = serve((req) =>
        Response.json({
          tag_name: resolvedVersion,
          assets: [
            {
              name: "marksman-linux-x64",
              browser_download_url: `http://${new URL(req.url).host}/assets/marksman-linux-x64`,
              digest: `sha256:${resolvedSHA}`,
            },
          ],
        }),
      );
      const res = await resolveMarksmanRuntimeDependency(
        undefined,
        fetch,
        srv.url,
        dep("linux-amd64"),
        selector,
      );
      expect(srv.hits).toEqual([wantPath]);
      expect(res.resolved_version).toBe(resolvedVersion);
      expect(res.dependency.version).toBe(resolvedVersion);
      expect(res.dependency.sha256).toBe(resolvedSHA);
      expect(res.integrity).toBe(`sha256:${resolvedSHA}`);
      expect(res.dependency.url?.endsWith("/assets/marksman-linux-x64")).toBe(true);
    });
  }

  test("rejects a missing digest", async () => {
    const srv = serve((req) =>
      Response.json({
        tag_name: "2026-07-20",
        assets: [
          {
            name: "marksman-linux-x64",
            browser_download_url: `http://${new URL(req.url).host}/assets/marksman-linux-x64`,
          },
        ],
      }),
    );
    await expect(
      resolveMarksmanRuntimeDependency(undefined, fetch, srv.url, dep("linux-amd64"), {
        latest: true,
      }),
    ).rejects.toThrow("missing published SHA-256 digest");
  });
});

describe("terraform-ls", () => {
  const a = newTerraformLSAdapter();
  const dep = (platform: string): RuntimeDependency => {
    const d = a.runtimeDeps().find((x) => x.platform_id === platform);
    if (!d) throw new Error(`missing ${platform}`);
    return d;
  };

  test("contracts", () => {
    expect(a.id()).toBe("terraform");
    expect(a.name()).toBe("Terraform");
    expect(a.extensions()).toEqual([".tf", ".tfvars", ".tf.json", ".tfvars.json"]);
    expect(a.lazyStart()).toBe(true);
    expect(a.capabilityProfile()).toEqual(codeCapabilityProfile());
    expect(a.supportsImplementation()).toBe(false);
    const b = a.binaries();
    expect(b).toHaveLength(1);
    expect(b[0]?.name).toBe("terraform-ls");
    expect(b[0]?.args).toEqual(["serve"]);
    expect(b[0]?.check_args).toEqual(["version"]);
    expect(a.defaultArgs()).toEqual(["serve"]);
    expect(a.prerequisites()[0]?.check_cmd).toBe("terraform version");
  });

  test("document sync", () => {
    const cases: [string, { languageID: string; suppress: boolean }][] = [
      ["main.tf", { languageID: "terraform", suppress: false }],
      ["production.tfvars", { languageID: "terraform-vars", suppress: false }],
      ["network.tf.json", { languageID: "terraform", suppress: true }],
      ["C:\\repo\\PRODUCTION.TFVARS.JSON", { languageID: "terraform-vars", suppress: true }],
    ];
    for (const [path, want] of cases) expect(a.documentSyncForPath(path)).toEqual(want);
  });

  test("path capabilities", () => {
    for (const p of ["network.tf.json", "C:\\repo\\PRODUCTION.TFVARS.JSON"]) {
      const [d, handled] = a.pathCapabilityForAction(p, "definition", "definition");
      expect(handled).toBe(true);
      expect(d.supported).toBe(false);
      expect(d.capabilities ?? []).toHaveLength(0);
      expect(d.advertisedCapabilities ?? []).toHaveLength(0);
      expect(d.explanation).toContain("does not support Terraform JSON");
    }
    for (const p of ["main.tf", "production.tfvars"]) {
      expect(a.pathCapabilityForAction(p, "definition", "definition")[1]).toBe(false);
    }
  });

  test("routing precedes JSON", () => {
    const r = Registry.empty();
    r.register(languageOf(newJSONAdapter()));
    r.register(languageOf(a));
    for (const p of ["main.tf", "production.tfvars", "network.tf.json", "production.tfvars.json"]) {
      expect(r.forPath(p)?.id).toBe("terraform");
      expect(r.forDetection(p)?.id).toBe("terraform");
    }
    for (const p of ["settings.json", "settings.jsonc"]) expect(r.forPath(p)?.id).toBe("json");
    for (const p of [
      "module.hcl",
      "main.tf.json.backup",
      ".knowns/main.tf",
      "C:\\repo\\.knowns\\main.tfvars.json",
    ]) {
      expect(r.forPath(p)).toBeUndefined();
    }
  });

  test("recommended release metadata", () => {
    const want: Record<string, string> = {
      "darwin-amd64": "34cfe6cbbb61da5b8fd21721e14be0f134417f249350872da1669454dc8762a4",
      "darwin-arm64": "510a506f7bf1550294202347261961e52daa4664a795e2deffbf7df7296b1f6c",
      "linux-amd64": "d16077d9c83f13ac33501af49ea75f43218d3fa2437c6c1374550b2625edc3ef",
      "linux-arm64": "762db754428dd188b949533ca05437955e26f4b3fc699d4b93392668a24e7a10",
      "windows-amd64": "5152e76e45103ea2a31b8a8dadc43833ae559a4aba4cb12f57c1c006c11dda8c",
      "windows-arm64": "5cee26a3645487125bf65daee8cfc85c84d8c7e03bbb00662fb12225afe9d6cd",
    };
    const deps = a.runtimeDeps();
    expect(deps).toHaveLength(6);
    for (const d of deps) {
      const sha = want[d.platform_id ?? ""];
      expect(sha).toBeDefined();
      expect(d.version).toBe(terraformLSRecommendedVersion);
      expect(d.recommended_version).toBe(terraformLSRecommendedVersion);
      expect(d.sha256).toBe(sha);
      expect(d.recommended_integrity).toBe(`sha256:${sha}`);
      expect(d.source).toBe("release");
      expect(d.archive_type).toBe("zip");
      expect(d.binary_name).toBe("terraform-ls");
      expect(
        d.url?.startsWith(`${terraformLSReleasesBase}/${terraformLSRecommendedVersion}/`),
      ).toBe(true);
      if (d.platform_id?.startsWith("windows-")) expect(d.extract_path).toBe("terraform-ls.exe");
    }
  });

  test("recommended resolution is pinned and offline", async () => {
    const d = dep("linux-amd64");
    const res = await resolveTerraformLSRuntimeDependency(undefined, undefined, "", "", d, {});
    expect(res.resolved_version).toBe(terraformLSRecommendedVersion);
    expect(res.dependency.url).toBe(d.url);
    expect(res.integrity).toBe(d.recommended_integrity);
  });

  const version = "0.39.0";
  const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const archive = "terraform-ls_0.39.0_linux_amd64.zip";
  for (const [name, selector, wantLatest] of [
    ["latest", { latest: true }, true],
    ["tag", { version: `v${version}` }, false],
  ] as const) {
    test(`latest and tag: ${name}`, async () => {
      const srv = serve((req) => {
        const p = new URL(req.url).pathname;
        if (p === "/github/latest") return Response.json({ tag_name: `v${version}` });
        if (p === `/releases/${version}/terraform-ls_${version}_SHA256SUMS`)
          return new Response(`${sha}  ${archive}\n`);
        return new Response("not found", { status: 404 });
      });
      const res = await resolveTerraformLSRuntimeDependency(
        undefined,
        fetch,
        `${srv.url}/github`,
        `${srv.url}/releases`,
        dep("linux-amd64"),
        selector,
      );
      expect(srv.hits.includes("/github/latest")).toBe(wantLatest);
      expect(res.resolved_version).toBe(version);
      expect(res.dependency.version).toBe(version);
      expect(res.dependency.sha256).toBe(sha);
      expect(res.integrity).toBe(`sha256:${sha}`);
      expect(res.dependency.url?.endsWith(`/${archive}`)).toBe(true);
    });
  }

  test("fails closed", async () => {
    const srv = serve(() => new Response("not-a-checksum  terraform-ls_0.39.0_linux_amd64.zip\n"));
    await expect(
      resolveTerraformLSRuntimeDependency(undefined, fetch, srv.url, srv.url, dep("linux-amd64"), {
        version: "0.39.0",
      }),
    ).rejects.toThrow("invalid SHA-256");
    await expect(
      resolveTerraformLSRuntimeDependency(undefined, fetch, srv.url, srv.url, dep("linux-amd64"), {
        version: "../../0.39.0",
      }),
    ).rejects.toThrow("invalid terraform-ls release version");
  });
});
