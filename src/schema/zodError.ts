import type { z } from "zod";

// zod v4's `error.message` is a JSON dump of the issue tree — unreadable in a notebook, a console, or
// a thrown message. Every webpic zod boundary renders issues the same way instead: path, then reason.
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
