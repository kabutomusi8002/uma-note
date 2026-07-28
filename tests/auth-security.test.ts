import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx|js|jsx)$/.test(name)
        ? [path]
        : [];
  });
}

describe("browser credential boundary", () => {
  it("uses only browser-safe public Supabase keys", () => {
    const client = readFileSync(join(root, "lib/supabase/client.ts"), "utf8");
    expect(client).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(client).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(client).not.toMatch(/SERVICE_ROLE|SUPABASE_SECRET|DATABASE_URL/);
  });

  it("does not expose server secrets through NEXT_PUBLIC or browser modules", () => {
    const envExample = readFileSync(join(root, ".env.example"), "utf8");
    expect(envExample).toMatch(/^NEXT_PUBLIC_SUPABASE_URL=\s*$/m);
    expect(envExample).toMatch(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\s*$/m);
    expect(envExample).not.toMatch(
      /^(?:NEXT_PUBLIC_.*(?:SECRET|SERVICE_ROLE|PASSWORD)|SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY|DATABASE_URL)\s*=/m,
    );

    const browserSource = [
      ...sourceFiles(join(root, "app")),
      ...sourceFiles(join(root, "lib")),
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(browserSource).not.toMatch(
      /process\.env\.(?:SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY|DATABASE_URL|DB_PASSWORD)/,
    );
  });
});
