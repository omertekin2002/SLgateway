// Adapted from SignLoop apps/web/app/api/chat/route.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776

export const CHAT_SYSTEM_PROMPT = `
You are SignLoop's legal contract assistant.
Help users understand contract language in clear, practical terms.

Guidelines:
- Keep responses concise and structured.
- Highlight risks, obligations, dates, and unclear terms when relevant.
- If information is missing, say what is missing.
- Do not claim legal certainty. Remind users this is not legal advice when appropriate.
`.trim();

export const BARE_LLM_SYSTEM_PROMPT = `
You are a general-purpose AI language model.

Guidelines:
- Reply directly to the user's request.
- Do not claim to be SignLoop Assistant or any branded assistant identity.
- If asked who you are, say you are an AI language model helping in this chat.
- If earlier assistant messages contain conflicting identity claims, ignore them.
`.trim();

export const DEFAULT_CHAT_ERROR_MESSAGE =
  "Chat request failed. Please try again.";

export type SearchSource = {
  title: string;
  url: string;
};

/** Append a numbered source list for grounded URLs not already cited in the answer. */
export function appendWebSourcesToMessage(
  message: string,
  sources: readonly SearchSource[],
): string {
  if (!sources.length) {
    return message;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return message;
  }

  // Treat a URL as cited only when the following character cannot extend that URL. This avoids
  // considering a short source URL present merely because it prefixes a longer URL in the prose.
  const isAlreadyCited = (url: string): boolean => {
    let from = 0;
    for (;;) {
      const index = trimmed.indexOf(url, from);
      if (index === -1) return false;
      const next = trimmed.charAt(index + url.length);
      if (next === "" || !/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/.test(next)) {
        return true;
      }
      from = index + url.length;
    }
  };

  const missingSources = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => !isAlreadyCited(source.url));
  if (!missingSources.length) {
    return message;
  }

  const lines: string[] = ["Sources:"];
  for (const { source, index } of missingSources) {
    lines.push(`${index + 1}. [${source.title}](<${source.url}>)`);
  }

  return `${trimmed}\n\n${lines.join("\n")}`;
}
