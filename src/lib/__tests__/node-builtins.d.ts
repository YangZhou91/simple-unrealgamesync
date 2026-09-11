declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Dirent[];
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:path" {
  interface PlatformPath {
    resolve(...paths: string[]): string;
    dirname(p: string): string;
    join(...paths: string[]): string;
    relative(from: string, to: string): string;
    sep: string;
  }
  const path: PlatformPath;
  export default path;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
