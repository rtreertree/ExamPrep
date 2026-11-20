import type { StudyContent } from "./content";
import type { OwnershipRole } from "./sharing";

export type DirectoryPage<T> = { items: T[]; next: string | null };
export type DirectoryUser = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  suspended: boolean;
};
export type DirectorySet = {
  id: string;
  title: string;
  ownerName: string;
  kind: StudyContent["kind"];
  count: number;
  published?: boolean;
  ownershipRole?: OwnershipRole;
  archived?: boolean;
};
export type SetReaderData = { ownerName: string; content: StudyContent };
export type SetAccessSummary = {
  revision: number;
  published: boolean;
  coOwners: number;
  invitations: number;
  link: string | null;
};
export type ShareRecipient = {
  id: string;
  name: string;
  email: string;
  invited: boolean;
};
