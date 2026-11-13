import type { StudyContent } from "./content";

export type OwnershipRole = "primary" | "co_owner";

export type SharedSetPreview = {
  title: string;
  kind: StudyContent["kind"];
  count: number;
};

export type OwnershipInvitation = {
  id: string;
  title: string;
  kind: StudyContent["kind"];
  ownerEmail: string;
};

export type ShareSettings = {
  link: string | null;
  coOwners: { id: string; email: string }[];
  invitations: { id: string; email: string }[];
};
