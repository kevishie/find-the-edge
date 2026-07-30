import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const packageRules = {
  auth: ["config", "domain"],
  config: [],
  database: ["config", "domain"],
  domain: [],
  observability: ["config"],
  odds: ["domain"],
  providers: ["config", "domain", "observability"],
  scouting: ["domain", "odds", "sports"],
  sports: ["domain", "odds"],
  "test-utils": [
    "auth",
    "config",
    "database",
    "domain",
    "observability",
    "odds",
    "providers",
    "scouting",
    "sports",
    "ui",
  ],
  ui: ["domain"],
};

export function validatePackageGraph(packages, rules = packageRules) {
  const failures = [];
  for (const item of packages) {
    const allowed = new Set(rules[item.name] ?? []);
    for (const dependency of item.dependencies) {
      if (dependency === item.name || !allowed.has(dependency)) {
        failures.push(`${item.name} must not depend on ${dependency}`);
      }
    }
  }
  return failures;
}

async function workspacePackages(root) {
  const packagesDirectory = path.join(root, "packages");
  const directories = await readdir(packagesDirectory, { withFileTypes: true });
  return Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifest = JSON.parse(
          await readFile(
            path.join(packagesDirectory, entry.name, "package.json"),
            "utf8",
          ),
        );
        const dependencies = Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
        })
          .filter((name) => name.startsWith("@find-the-edge/"))
          .map((name) => name.replace("@find-the-edge/", ""));
        return { name: entry.name, dependencies };
      }),
  );
}

export async function checkWorkspace(root) {
  const packages = await workspacePackages(root);
  const unknown = packages
    .map(({ name }) => name)
    .filter((name) => !(name in packageRules));
  return [
    ...unknown.map((name) => `No boundary rule declared for ${name}`),
    ...validatePackageGraph(packages),
  ];
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const failures = await checkWorkspace(process.cwd());
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Package boundaries valid.");
  }
}
