/**
 * Files the owner attaches to a message are uploaded into the agent's workspace first, then listed on the
 * message's last line ("附件：path、path"). The agent reads the paths from there; the app parses the same
 * line back to show the files (images as thumbnails) instead of raw paths.
 */
export const ATTACHMENT_LABEL = "附件：";
/** Where uploads land inside the agent container. */
export const UPLOAD_DIR = "/workspace/uploads/";
/** What the model can take as an image input. */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** The message text with the attachment line appended (or alone when there is no text). */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const line = `${ATTACHMENT_LABEL}${paths.join("、")}`;
  return text ? `${text}\n\n${line}` : line;
}

/** Splits a message into the typed text and the uploaded files listed on its attachment line. */
export function splitAttachments(text: string): { text: string; paths: string[] } {
  const at = text.lastIndexOf(ATTACHMENT_LABEL);
  if (at < 0 || (at > 0 && !text.slice(0, at).endsWith("\n\n"))) return { text, paths: [] };
  const paths = text.slice(at + ATTACHMENT_LABEL.length).split("、");
  if (!paths.every((p) => p.startsWith(UPLOAD_DIR) && p.length > UPLOAD_DIR.length && !p.slice(UPLOAD_DIR.length).includes("/"))) return { text, paths: [] };
  return { text: text.slice(0, at).trimEnd(), paths };
}

/** Display name of an upload: the stored name without its timestamp prefix. */
export function uploadName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/^\d+-/, "");
}
