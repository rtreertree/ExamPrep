import type { StudyContent } from "./content";

export type OwnershipRole = "primary" | "co_owner" | "viewer";

export type OwnershipInvitation = {
  id: string;
  title: string;
  kind: StudyContent["kind"];
  ownerEmail: string;
};

export type ShareSettings = {
  link: string | null;
  guestAccess?: boolean;
  coOwners: { id: string; email: string }[];
  invitations: { id: string; email: string }[];
};
