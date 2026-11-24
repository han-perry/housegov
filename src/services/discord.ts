// Stretch goal: one-way Discord feed. A webhook pointed at a *forum* channel
// accepts `thread_name`, which creates a new discussion thread per post.
import { config } from "../config";

export async function announce({ threadName, content }: { threadName: string; content: string }): Promise<void> {
  if (!config.discordWebhookUrl) return;
  try {
    await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_name: threadName.slice(0, 100), content: content.slice(0, 2000) }),
    });
  } catch (e) {
    console.warn("[discord] post failed:", (e as Error).message);
  }
}
