const SESSION_ID_CHARS = 8;

/** Render stored titles without migrating legacy skill envelopes on disk. */
export function sessionTitleText(title: string | null, sessionId: string): string {
  if (title === null) return `untitled ${sessionId.slice(0, SESSION_ID_CHARS)}`;
  const skill = /^<skill name="([^"]*)"\s/u.exec(title);
  return skill ? `/${skill[1]}` : title;
}
