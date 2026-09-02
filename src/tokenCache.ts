import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CachedTokens = {
  idToken: string;
  refreshToken?: string;
  obtainedAt: number;
};

export class FileTokenCache {
  constructor(private readonly path: string) {}

  async load(): Promise<CachedTokens | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as CachedTokens;
    } catch {
      return null;
    }
  }

  async save(tokens: CachedTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(tokens), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}
