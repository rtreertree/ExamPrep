import { serializeContent, type StudyContent } from "../../shared/content";
import { download } from "./api";

export function exportContent(content: StudyContent) {
  download(
    serializeContent(content),
    (content.title.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 80) ||
      "study-set") + ".examprep.json",
  );
}
