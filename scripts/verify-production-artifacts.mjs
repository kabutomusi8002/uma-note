import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const outputDirectory = join(root, "dist");
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".txt",
]);

const forbiddenDiagnosticRoutes = [
  "/__diagnostics",
  "/diagnostics/rls",
  "/prediction-lock-diagnostic",
];

const credentialPatterns = [
  {
    label: "Supabase secret key",
    pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}\b/i,
  },
  {
    label: "legacy service-role JWT payload",
    pattern: /\bc2VydmljZV9yb2xl\b/i,
  },
  {
    label: "database connection string with embedded password",
    pattern: /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@/i,
  },
  {
    label: "SMTP credential",
    pattern: /\bxsmtpsib-[A-Za-z0-9_-]{20,}\b/i,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

function textFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return textExtensions.has(extname(name).toLowerCase()) ? [path] : [];
  });
}

function fail(message) {
  console.error(`Production artifact verification failed: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(outputDirectory)) {
  fail("dist does not exist; run the production build first");
} else {
  const files = textFiles(outputDirectory);
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const displayPath = relative(root, path).replaceAll("\\", "/");

    for (const route of forbiddenDiagnosticRoutes) {
      if (source.includes(route)) {
        fail(`diagnostic route ${route} is present in ${displayPath}`);
      }
    }

    for (const { label, pattern } of credentialPatterns) {
      if (pattern.test(source)) {
        fail(`${label} is present in ${displayPath}`);
      }
    }
  }

  if (!process.exitCode) {
    console.log(
      `Production artifact verification passed (${files.length} text artifacts scanned).`,
    );
  }
}
