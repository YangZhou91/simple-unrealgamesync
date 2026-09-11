/// <reference types="vite/client" />

declare module "virtual:changelog" {
  export interface CommitEntry {
    hash: string;
    date: string;
    subject: string;
  }
  export const changelog: CommitEntry[];
}
